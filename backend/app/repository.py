"""Thread-safe SQLite storage for plaintext legacy and Phase 4 envelopes."""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


class E2EERequiredError(RuntimeError):
    """A plaintext write was attempted after the room entered E2EE mode."""


class E2EENotEnabledError(RuntimeError):
    """An encrypted write was attempted before the room entered E2EE mode."""


class MessageIdConflictError(RuntimeError):
    """A client message ID was reused for different immutable content."""


class E2EEIVReuseError(RuntimeError):
    """An AES-GCM IV was reused with the same room key identifier."""


@dataclass(frozen=True, slots=True)
class MessageRecord:
    id: int
    client_message_id: str
    sender_id: str
    sender_name: str
    sent_at: str
    kind: Literal["message", "encrypted_message"]
    text: str | None = None
    e2ee_version: str | None = None
    algorithm: str | None = None
    key_id: str | None = None
    sender_key_id: str | None = None
    iv: str | None = None
    ciphertext: str | None = None

    def as_dict(self, *, legacy_plaintext: bool = False) -> dict[str, object]:
        common: dict[str, object] = {
            "id": str(self.id),
            "client_message_id": self.client_message_id,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "sent_at": self.sent_at,
            "kind": self.kind,
        }
        if self.kind == "message":
            assert self.text is not None
            common["text"] = self.text
            if legacy_plaintext:
                common["legacy_plaintext"] = True
            return common

        assert self.e2ee_version is not None
        assert self.algorithm is not None
        assert self.key_id is not None
        assert self.sender_key_id is not None
        assert self.iv is not None
        assert self.ciphertext is not None
        common.update(
            {
                "version": self.e2ee_version,
                "algorithm": self.algorithm,
                "key_id": self.key_id,
                "sender_key_id": self.sender_key_id,
                "iv": self.iv,
                "ciphertext": self.ciphertext,
            }
        )
        return common


class SQLiteMessageRepository:
    _MESSAGE_COLUMNS = {
        "id",
        "room_id",
        "client_message_id",
        "sender_id",
        "sender_name",
        "sent_at",
        "kind",
        "text",
        "e2ee_version",
        "algorithm",
        "key_id",
        "sender_key_id",
        "iv",
        "ciphertext",
    }
    _LEGACY_MESSAGE_COLUMNS = {
        "id",
        "room_id",
        "client_message_id",
        "sender_id",
        "sender_name",
        "text",
        "sent_at",
    }

    def __init__(self, database_path: str) -> None:
        self.database_path = database_path
        self._lock = threading.RLock()
        if database_path != ":memory:":
            Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @staticmethod
    def _create_messages_table(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                client_message_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                sent_at TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('message', 'encrypted_message')),
                text TEXT,
                e2ee_version TEXT,
                algorithm TEXT,
                key_id TEXT,
                sender_key_id TEXT,
                iv TEXT,
                ciphertext TEXT,
                UNIQUE(room_id, sender_id, client_message_id),
                CHECK (
                    (
                        kind = 'message'
                        AND text IS NOT NULL
                        AND e2ee_version IS NULL
                        AND algorithm IS NULL
                        AND key_id IS NULL
                        AND sender_key_id IS NULL
                        AND iv IS NULL
                        AND ciphertext IS NULL
                    )
                    OR
                    (
                        kind = 'encrypted_message'
                        AND text IS NULL
                        AND e2ee_version IS NOT NULL
                        AND algorithm IS NOT NULL
                        AND key_id IS NOT NULL
                        AND sender_key_id IS NOT NULL
                        AND iv IS NOT NULL
                        AND ciphertext IS NOT NULL
                    )
                )
            )
            """
        )

    def initialize(self) -> None:
        with self._lock, self._connect() as connection:
            if self.database_path != ":memory:":
                connection.execute("PRAGMA journal_mode = WAL")

            table_exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
            ).fetchone()
            if table_exists is None:
                self._create_messages_table(connection)
            else:
                columns = {
                    row["name"]
                    for row in connection.execute("PRAGMA table_info(messages)")
                }
                if not self._MESSAGE_COLUMNS.issubset(columns):
                    if columns != self._LEGACY_MESSAGE_COLUMNS:
                        raise RuntimeError("unsupported messages table schema")
                    connection.execute("ALTER TABLE messages RENAME TO messages_phase3")
                    self._create_messages_table(connection)
                    connection.execute(
                        """
                        INSERT INTO messages (
                            id, room_id, client_message_id, sender_id,
                            sender_name, sent_at, kind, text
                        )
                        SELECT
                            id, room_id, client_message_id, sender_id,
                            sender_name, sent_at, 'message', text
                        FROM messages_phase3
                        """
                    )
                    connection.execute("DROP TABLE messages_phase3")

            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_messages_room_id_id
                ON messages(room_id, id DESC)
                """
            )
            # Early Phase 4 development builds used this name for a pair-wide
            # IV index. Remove it so an existing local database receives the
            # final directional-key namespace rather than silently retaining
            # stale uniqueness semantics.
            connection.execute("DROP INDEX IF EXISTS idx_messages_unique_e2ee_iv")
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_e2ee_sender_iv
                ON messages(room_id, key_id, sender_key_id, iv)
                WHERE kind = 'encrypted_message'
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS room_security (
                    room_id TEXT PRIMARY KEY,
                    e2ee_required INTEGER NOT NULL CHECK(e2ee_required = 1),
                    activated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TRIGGER IF NOT EXISTS prevent_plaintext_in_e2ee_room
                BEFORE INSERT ON messages
                WHEN NEW.kind = 'message' AND EXISTS (
                    SELECT 1 FROM room_security
                    WHERE room_id = NEW.room_id AND e2ee_required = 1
                )
                BEGIN
                    SELECT RAISE(ABORT, 'e2ee_required');
                END
                """
            )
            connection.execute("PRAGMA optimize")

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> MessageRecord:
        return MessageRecord(
            id=row["id"],
            client_message_id=row["client_message_id"],
            sender_id=row["sender_id"],
            sender_name=row["sender_name"],
            sent_at=row["sent_at"],
            kind=row["kind"],
            text=row["text"],
            e2ee_version=row["e2ee_version"],
            algorithm=row["algorithm"],
            key_id=row["key_id"],
            sender_key_id=row["sender_key_id"],
            iv=row["iv"],
            ciphertext=row["ciphertext"],
        )

    @staticmethod
    def _room_requires_e2ee(
        connection: sqlite3.Connection,
        room_id: str,
    ) -> bool:
        return (
            connection.execute(
                "SELECT 1 FROM room_security WHERE room_id = ? AND e2ee_required = 1",
                (room_id,),
            ).fetchone()
            is not None
        )

    def require_e2ee(self, room_id: str, activated_at: str) -> bool:
        """Durably lock a room against future plaintext writes."""

        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO room_security (room_id, e2ee_required, activated_at)
                VALUES (?, 1, ?)
                ON CONFLICT(room_id) DO NOTHING
                """,
                (room_id, activated_at),
            )
            return cursor.rowcount == 1

    def is_e2ee_required(self, room_id: str) -> bool:
        with self._lock, self._connect() as connection:
            return self._room_requires_e2ee(connection, room_id)

    def create_message(
        self,
        *,
        room_id: str,
        client_message_id: str,
        sender_id: str,
        sender_name: str,
        text: str,
        sent_at: str,
    ) -> tuple[MessageRecord, bool]:
        with self._lock, self._connect() as connection:
            if self._room_requires_e2ee(connection, room_id):
                raise E2EERequiredError("room requires encrypted messages")
            try:
                cursor = connection.execute(
                    """
                    INSERT INTO messages (
                        room_id, client_message_id, sender_id,
                        sender_name, sent_at, kind, text
                    ) VALUES (?, ?, ?, ?, ?, 'message', ?)
                    """,
                    (
                        room_id,
                        client_message_id,
                        sender_id,
                        sender_name,
                        sent_at,
                        text,
                    ),
                )
                row = connection.execute(
                    "SELECT * FROM messages WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
                assert row is not None
                return self._row_to_record(row), True
            except sqlite3.IntegrityError as exc:
                if "e2ee_required" in str(exc):
                    raise E2EERequiredError(
                        "room requires encrypted messages"
                    ) from exc
                row = connection.execute(
                    """
                    SELECT * FROM messages
                    WHERE room_id = ? AND sender_id = ? AND client_message_id = ?
                    """,
                    (room_id, sender_id, client_message_id),
                ).fetchone()
                if row is None:
                    raise
                return self._row_to_record(row), False

    def create_encrypted_message(
        self,
        *,
        room_id: str,
        client_message_id: str,
        sender_id: str,
        sender_name: str,
        sent_at: str,
        version: str,
        algorithm: str,
        key_id: str,
        sender_key_id: str,
        iv: str,
        ciphertext: str,
    ) -> tuple[MessageRecord, bool]:
        """Persist an opaque envelope with a database-level null plaintext."""

        with self._lock, self._connect() as connection:
            if not self._room_requires_e2ee(connection, room_id):
                raise E2EENotEnabledError("room is not in E2EE mode")
            try:
                cursor = connection.execute(
                    """
                    INSERT INTO messages (
                        room_id, client_message_id, sender_id, sender_name,
                        sent_at, kind, text, e2ee_version, algorithm, key_id,
                        sender_key_id, iv, ciphertext
                    ) VALUES (?, ?, ?, ?, ?, 'encrypted_message', NULL, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        room_id,
                        client_message_id,
                        sender_id,
                        sender_name,
                        sent_at,
                        version,
                        algorithm,
                        key_id,
                        sender_key_id,
                        iv,
                        ciphertext,
                    ),
                )
                row = connection.execute(
                    "SELECT * FROM messages WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
                assert row is not None
                return self._row_to_record(row), True
            except sqlite3.IntegrityError as exc:
                row = connection.execute(
                    """
                    SELECT * FROM messages
                    WHERE room_id = ? AND sender_id = ? AND client_message_id = ?
                    """,
                    (room_id, sender_id, client_message_id),
                ).fetchone()
                if row is None:
                    if (
                        "messages.room_id, messages.key_id, "
                        "messages.sender_key_id, messages.iv"
                    ) in str(exc):
                        raise E2EEIVReuseError(
                            "AES-GCM IV was already used with this room key"
                        ) from exc
                    raise
                existing = self._row_to_record(row)
                immutable_envelope = (
                    existing.kind,
                    existing.e2ee_version,
                    existing.algorithm,
                    existing.key_id,
                    existing.sender_key_id,
                    existing.iv,
                    existing.ciphertext,
                )
                requested_envelope = (
                    "encrypted_message",
                    version,
                    algorithm,
                    key_id,
                    sender_key_id,
                    iv,
                    ciphertext,
                )
                if immutable_envelope != requested_envelope:
                    raise MessageIdConflictError(
                        "client_message_id was reused for another envelope"
                    )
                return existing, False

    def list_messages(self, room_id: str, limit: int) -> list[MessageRecord]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM messages
                WHERE room_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (room_id, limit),
            ).fetchall()
        return [self._row_to_record(row) for row in reversed(rows)]

    def ping(self) -> bool:
        with self._lock, self._connect() as connection:
            return connection.execute("SELECT 1").fetchone()[0] == 1
