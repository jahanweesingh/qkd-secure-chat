from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.e2ee import (
    E2EE_MESSAGE_ALGORITHM,
    E2EE_PUBLIC_KEY_ALGORITHM,
    E2EE_VERSION,
    MAX_E2EE_CIPHERTEXT_BYTES,
    MAX_E2EE_PLAINTEXT_BYTES,
    decode_base64url,
    encode_base64url,
    pair_key_id,
    public_key_id,
    validate_ciphertext,
)
from app.main import create_app
from app.repository import (
    E2EEIVReuseError,
    E2EERequiredError,
    MessageIdConflictError,
    SQLiteMessageRepository,
)
from app.schemas import E2EEHelloCommand, EncryptedMessageCommand

from .conftest import receive_initial, socket_url


def raw_public_key(marker: int) -> bytes:
    return b"\x04" + bytes([marker]) * 64


def hello(marker: int) -> dict[str, str]:
    raw = raw_public_key(marker)
    return {
        "type": "e2ee_hello",
        "version": E2EE_VERSION,
        "algorithm": E2EE_PUBLIC_KEY_ALGORITHM,
        "public_key_id": public_key_id(raw),
        "public_key": encode_base64url(raw),
    }


def public_key_event(
    marker: int,
    *,
    client_id: str,
    display_name: str,
) -> dict[str, str]:
    return {
        "type": "e2ee_public_key",
        "client_id": client_id,
        "display_name": display_name,
        **{key: value for key, value in hello(marker).items() if key != "type"},
    }


def encrypted_message(
    room_id: str,
    *,
    client_message_id: str = "encrypted-1",
    iv_byte: int = 7,
    ciphertext: bytes = b"opaque-ciphertext",
    key_markers: tuple[int, int] = (1, 2),
) -> dict[str, str]:
    return {
        "type": "encrypted_message",
        "client_message_id": client_message_id,
        "version": E2EE_VERSION,
        "algorithm": E2EE_MESSAGE_ALGORITHM,
        "key_id": pair_key_id(
            room_id,
            [raw_public_key(key_markers[0]), raw_public_key(key_markers[1])],
        ),
        "iv": encode_base64url(bytes([iv_byte]) * 12),
        "ciphertext": encode_base64url(ciphertext),
    }


def phase4_settings(database_path: Path) -> Settings:
    return Settings(
        database_path=str(database_path),
        allowed_origins=("http://localhost:5173",),
        default_history_limit=50,
        max_history_limit=100,
        max_message_length=2_000,
        max_websocket_event_bytes=8_192,
    )


def register_pair(alice, bob) -> str:
    alice.send_json(hello(1))
    expected_alice = public_key_event(
        1,
        client_id="alice",
        display_name="Alice",
    )
    assert alice.receive_json() == expected_alice
    assert bob.receive_json() == expected_alice

    bob.send_json(hello(2))
    expected_bob = public_key_event(
        2,
        client_id="bob",
        display_name="Bob",
    )
    assert alice.receive_json() == expected_bob
    assert bob.receive_json() == expected_bob
    return pair_key_id("demo", [raw_public_key(1), raw_public_key(2)])


def test_base64url_and_key_identifiers_are_canonical_and_deterministic() -> None:
    raw = raw_public_key(1)
    encoded = encode_base64url(raw)
    assert "=" not in encoded
    assert decode_base64url(encoded, field_name="value") == raw
    with pytest.raises(ValueError, match="unpadded base64url"):
        decode_base64url(encoded + "=", field_name="value")
    with pytest.raises(ValueError, match="unpadded base64url"):
        decode_base64url("A", field_name="value")

    first = pair_key_id("room-a", [raw_public_key(1), raw_public_key(2)])
    assert first == pair_key_id("room-a", [raw_public_key(2), raw_public_key(1)])
    assert first != pair_key_id("room-b", [raw_public_key(1), raw_public_key(2)])
    assert len(first) == len(public_key_id(raw)) == 43

    # Shared browser/server vector. Ordering is unsigned lexicographic over the
    # decoded 65-byte keys, never locale ordering over their encoded strings.
    vector_left = decode_base64url(
        "BAfw4JAvNFqMGJA31Y7nbxq5LVOcaSTeWIYyIaw7RCRBWZjLh2rMXiedLTdoH7Hoe8CGqxMmZzd-hlyJY1v1h4A",
        field_name="public_key",
    )
    vector_right = decode_base64url(
        "BAL9qQygQBQUvnJDexIwQHW26icUi84IvRQuTxK9c-s9bh1gy57tiwagi8_MxXgRf57BO747UnNO6edX4lHN3-g",
        field_name="public_key",
    )
    assert pair_key_id("demo", [vector_left, vector_right]) == (
        "XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU"
    )


def test_strict_hello_validation_rejects_mismatch_shape_and_extra_fields() -> None:
    valid = hello(1)
    assert E2EEHelloCommand.model_validate(valid).public_key == valid["public_key"]

    for invalid in (
        {**valid, "public_key_id": public_key_id(raw_public_key(2))},
        {**valid, "public_key": encode_base64url(bytes(65))},
        {**valid, "version": "e2ee-v2"},
        {**valid, "unexpected": "value"},
    ):
        with pytest.raises(ValidationError):
            E2EEHelloCommand.model_validate(invalid)


def test_envelope_validation_enforces_iv_tag_and_4096_plaintext_byte_cap() -> None:
    assert MAX_E2EE_CIPHERTEXT_BYTES == MAX_E2EE_PLAINTEXT_BYTES + 16 == 4_112
    largest = encrypted_message(
        "demo",
        ciphertext=b"x" * MAX_E2EE_CIPHERTEXT_BYTES,
    )
    EncryptedMessageCommand.model_validate(largest)
    validate_ciphertext(largest["ciphertext"])
    EncryptedMessageCommand.model_validate(
        encrypted_message("demo", ciphertext=b"x" * 17)
    )

    invalid_values = (
        {**largest, "iv": encode_base64url(b"short")},
        {**largest, "ciphertext": encode_base64url(b"x" * 16)},
        {
            **largest,
            "ciphertext": encode_base64url(
                b"x" * (MAX_E2EE_CIPHERTEXT_BYTES + 1)
            ),
        },
        {**largest, "algorithm": "AES-128-GCM"},
        {**largest, "text": "plaintext must never be accepted"},
    )
    for invalid in invalid_values:
        with pytest.raises(ValidationError):
            EncryptedMessageCommand.model_validate(invalid)


def test_repository_persists_ciphertext_only_and_enforces_lock_and_iv_uniqueness(
    database_path: Path,
) -> None:
    repository = SQLiteMessageRepository(str(database_path))
    repository.require_e2ee("demo", "2026-09-14T00:00:00.000Z")
    envelope = encrypted_message("demo")
    record, created = repository.create_encrypted_message(
        room_id="demo",
        client_message_id=envelope["client_message_id"],
        sender_id="alice",
        sender_name="Alice",
        sent_at="2026-09-14T00:00:01.000Z",
        version=envelope["version"],
        algorithm=envelope["algorithm"],
        key_id=envelope["key_id"],
        sender_key_id=public_key_id(raw_public_key(1)),
        iv=envelope["iv"],
        ciphertext=envelope["ciphertext"],
    )
    assert created is True
    assert "text" not in record.as_dict()

    duplicate, created = repository.create_encrypted_message(
        room_id="demo",
        client_message_id=envelope["client_message_id"],
        sender_id="alice",
        sender_name="Alice",
        sent_at="ignored-on-retry",
        version=envelope["version"],
        algorithm=envelope["algorithm"],
        key_id=envelope["key_id"],
        sender_key_id=public_key_id(raw_public_key(1)),
        iv=envelope["iv"],
        ciphertext=envelope["ciphertext"],
    )
    assert duplicate.id == record.id
    assert created is False

    opposite_direction, created = repository.create_encrypted_message(
        room_id="demo",
        client_message_id="opposite-direction-same-iv",
        sender_id="bob",
        sender_name="Bob",
        sent_at="2026-09-14T00:00:01.500Z",
        version=envelope["version"],
        algorithm=envelope["algorithm"],
        key_id=envelope["key_id"],
        sender_key_id=public_key_id(raw_public_key(2)),
        iv=envelope["iv"],
        ciphertext=envelope["ciphertext"],
    )
    assert created is True
    assert opposite_direction.sender_key_id == public_key_id(raw_public_key(2))

    with pytest.raises(MessageIdConflictError):
        repository.create_encrypted_message(
            room_id="demo",
            client_message_id=envelope["client_message_id"],
            sender_id="alice",
            sender_name="Alice",
            sent_at="2026-09-14T00:00:02.000Z",
            version=envelope["version"],
            algorithm=envelope["algorithm"],
            key_id=envelope["key_id"],
            sender_key_id=public_key_id(raw_public_key(1)),
            iv=encode_base64url(b"8" * 12),
            ciphertext=envelope["ciphertext"],
        )

    with pytest.raises(E2EEIVReuseError):
        repository.create_encrypted_message(
            room_id="demo",
            client_message_id="encrypted-iv-reuse",
            sender_id="alice",
            sender_name="Alice",
            sent_at="2026-09-14T00:00:03.000Z",
            version=envelope["version"],
            algorithm=envelope["algorithm"],
            key_id=envelope["key_id"],
            sender_key_id=public_key_id(raw_public_key(1)),
            iv=envelope["iv"],
            ciphertext=envelope["ciphertext"],
        )

    with pytest.raises(E2EERequiredError):
        repository.create_message(
            room_id="demo",
            client_message_id="forbidden-plaintext",
            sender_id="alice",
            sender_name="Alice",
            text="do not store me",
            sent_at="2026-09-14T00:00:04.000Z",
        )

    with sqlite3.connect(database_path) as connection:
        row = connection.execute(
            "SELECT kind, text, ciphertext, sender_key_id FROM messages"
        ).fetchone()
        assert row == (
            "encrypted_message",
            None,
            envelope["ciphertext"],
            public_key_id(raw_public_key(1)),
        )
        assert [
            row[2]
            for row in connection.execute(
                "PRAGMA index_info(idx_messages_unique_e2ee_sender_iv)"
            )
        ] == ["room_id", "key_id", "sender_key_id", "iv"]
        assert connection.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_messages_unique_e2ee_iv'
            """
        ).fetchone() is None
        with pytest.raises(sqlite3.IntegrityError, match="e2ee_required"):
            connection.execute(
                """
                INSERT INTO messages (
                    room_id, client_message_id, sender_id, sender_name,
                    sent_at, kind, text
                ) VALUES ('demo', 'direct-plaintext', 'alice', 'Alice',
                          '2026-09-14T00:00:05.000Z', 'message', 'forbidden')
                """
            )

    restarted = SQLiteMessageRepository(str(database_path))
    assert restarted.is_e2ee_required("demo") is True
    assert all(
        record.text is None for record in restarted.list_messages("demo", 50)
    )


def test_phase3_plaintext_database_migrates_without_relabeling_history(
    database_path: Path,
) -> None:
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                client_message_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                text TEXT NOT NULL,
                sent_at TEXT NOT NULL,
                UNIQUE(room_id, sender_id, client_message_id)
            )
            """
        )
        connection.execute(
            """
            INSERT INTO messages (
                room_id, client_message_id, sender_id, sender_name, text, sent_at
            ) VALUES ('demo', 'old-1', 'alice', 'Alice', 'old plaintext',
                      '2026-09-13T00:00:00.000Z')
            """
        )

    repository = SQLiteMessageRepository(str(database_path))
    migrated = repository.list_messages("demo", 50)
    assert len(migrated) == 1
    assert migrated[0].kind == "message"
    assert migrated[0].text == "old plaintext"
    assert migrated[0].ciphertext is None


def test_superseded_pair_wide_iv_index_is_replaced_on_startup(
    database_path: Path,
) -> None:
    SQLiteMessageRepository(str(database_path))
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP INDEX idx_messages_unique_e2ee_sender_iv")
        connection.execute(
            """
            CREATE UNIQUE INDEX idx_messages_unique_e2ee_iv
            ON messages(room_id, key_id, iv)
            WHERE kind = 'encrypted_message'
            """
        )

    SQLiteMessageRepository(str(database_path))
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_messages_unique_e2ee_iv'
            """
        ).fetchone() is None
        assert [
            row[2]
            for row in connection.execute(
                "PRAGMA index_info(idx_messages_unique_e2ee_sender_iv)"
            )
        ] == ["room_id", "key_id", "sender_key_id", "iv"]


def test_two_client_e2ee_relay_broadcast_and_history_are_identical(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            receive_initial(bob)
            assert alice.receive_json()["action"] == "joined"
            expected_key_id = register_pair(alice, bob)

            envelope = encrypted_message("demo")
            assert envelope["key_id"] == expected_key_id
            alice.send_json(envelope)
            acknowledgement = alice.receive_json()
            alice_event = alice.receive_json()
            bob_event = bob.receive_json()

            assert acknowledgement == {
                "type": "message_ack",
                "client_message_id": "encrypted-1",
                "message_id": "1",
                "sent_at": acknowledgement["sent_at"],
                "duplicate": False,
            }
            assert alice_event == bob_event
            assert alice_event["type"] == "encrypted_message"
            stored = alice_event["message"]
            assert stored == {
                "id": "1",
                "client_message_id": "encrypted-1",
                "sender_id": "alice",
                "sender_name": "Alice",
                "sent_at": acknowledgement["sent_at"],
                "kind": "encrypted_message",
                "version": E2EE_VERSION,
                "algorithm": E2EE_MESSAGE_ALGORITHM,
                "key_id": expected_key_id,
                "sender_key_id": public_key_id(raw_public_key(1)),
                "iv": envelope["iv"],
                "ciphertext": envelope["ciphertext"],
            }
            assert "text" not in stored

    history = client.get("/api/rooms/demo/messages").json()
    assert history["e2ee_required"] is True
    assert history["messages"] == [stored]


def test_first_hello_durably_blocks_plaintext_and_is_cached_for_later_peer(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        alice.send_json(hello(1))
        assert alice.receive_json() == public_key_event(
            1,
            client_id="alice",
            display_name="Alice",
        )

        alice.send_json(
            {
                "type": "message",
                "text": "plaintext downgrade",
                "client_message_id": "plaintext-after-hello",
            }
        )
        assert alice.receive_json() == {
            "type": "error",
            "code": "e2ee_required",
            "message": "This room now accepts encrypted-message envelopes only",
            "client_message_id": "plaintext-after-hello",
        }

        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            connected, _ = receive_initial(bob)
            assert connected["e2ee_required"] is True
            assert connected["e2ee_public_keys"] == [
                {
                    key: value
                    for key, value in public_key_event(
                        1,
                        client_id="alice",
                        display_name="Alice",
                    ).items()
                    if key != "type"
                }
            ]
            assert alice.receive_json()["action"] == "joined"


def test_rejected_hello_does_not_lock_room_or_block_plaintext(
    client: TestClient,
) -> None:
    invalid = hello(1)
    invalid["public_key_id"] = public_key_id(raw_public_key(2))
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        alice.send_json(invalid)
        assert alice.receive_json() == {
            "type": "error",
            "code": "validation_error",
            "message": "Event payload is invalid",
        }
        alice.send_json(
            {
                "type": "message",
                "text": "legacy allowed",
                "client_message_id": "after-rejected-hello",
            }
        )
        assert alice.receive_json()["type"] == "message_ack"
        assert alice.receive_json()["message"]["text"] == "legacy allowed"

    history = client.get("/api/rooms/demo/messages").json()
    assert history["e2ee_required"] is False
    assert history["messages"][0].get("legacy_plaintext") is None


def test_locked_room_restart_marks_legacy_plaintext_and_forgets_ephemeral_keys(
    database_path: Path,
) -> None:
    settings = phase4_settings(database_path)
    with TestClient(create_app(settings)) as first:
        with first.websocket_connect(socket_url()) as alice:
            receive_initial(alice)
            alice.send_json(
                {
                    "type": "message",
                    "text": "legacy before lock",
                    "client_message_id": "legacy-1",
                }
            )
            assert alice.receive_json()["type"] == "message_ack"
            assert alice.receive_json()["type"] == "message"
            alice.send_json(hello(1))
            assert alice.receive_json()["type"] == "e2ee_public_key"

    with TestClient(create_app(settings)) as restarted:
        with restarted.websocket_connect(socket_url()) as alice:
            connected, _ = receive_initial(alice)
            assert connected["e2ee_required"] is True
            assert connected["e2ee_public_keys"] == []
            assert connected["messages"][0]["kind"] == "message"
            assert connected["messages"][0]["legacy_plaintext"] is True
            assert connected["messages"][0]["text"] == "legacy before lock"
            alice.send_json(
                {
                    "type": "message",
                    "text": "still forbidden",
                    "client_message_id": "restart-downgrade",
                }
            )
            assert alice.receive_json()["code"] == "e2ee_required"


def test_malformed_wrong_pair_duplicate_conflict_and_iv_reuse_are_recoverable(
    database_path: Path,
) -> None:
    with TestClient(create_app(phase4_settings(database_path))) as client:
        with client.websocket_connect(socket_url()) as alice:
            receive_initial(alice)
            with client.websocket_connect(
                socket_url(client_id="bob", display_name="Bob")
            ) as bob:
                receive_initial(bob)
                assert alice.receive_json()["action"] == "joined"

                malformed = encrypted_message("demo", client_message_id="bad-iv")
                malformed["iv"] = encode_base64url(b"short")
                alice.send_json(malformed)
                assert alice.receive_json() == {
                    "type": "error",
                    "code": "validation_error",
                    "message": "Event payload is invalid",
                    "client_message_id": "bad-iv",
                }

                alice.send_json(encrypted_message("demo", client_message_id="too-early"))
                assert alice.receive_json()["code"] == "e2ee_not_ready"

                register_pair(alice, bob)
                wrong_pair = encrypted_message("demo", client_message_id="wrong-key")
                wrong_pair["key_id"] = public_key_id(raw_public_key(3))
                alice.send_json(wrong_pair)
                assert alice.receive_json()["code"] == "e2ee_key_mismatch"

                first = encrypted_message("demo", client_message_id="stable-id")
                alice.send_json(first)
                assert alice.receive_json()["duplicate"] is False
                assert alice.receive_json()["type"] == "encrypted_message"
                assert bob.receive_json()["type"] == "encrypted_message"

                alice.send_json(first)
                assert alice.receive_json()["duplicate"] is True

                changed = {**first, "ciphertext": encode_base64url(b"changed-ciphertext")}
                alice.send_json(changed)
                assert alice.receive_json()["code"] == "message_id_conflict"

                reused_iv = encrypted_message(
                    "demo",
                    client_message_id="different-id",
                    iv_byte=7,
                )
                alice.send_json(reused_iv)
                assert alice.receive_json()["code"] == "e2ee_iv_reuse"

                bob.send_json({"type": "ping"})
                assert bob.receive_json() == {"type": "pong"}


def test_departed_peer_blocks_old_context_until_replacement_pair_is_ready(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            receive_initial(bob)
            assert alice.receive_json()["action"] == "joined"
            register_pair(alice, bob)

        assert alice.receive_json() == {
            "type": "presence",
            "action": "left",
            "client_id": "bob",
            "display_name": "Bob",
            "participants": [{"client_id": "alice", "display_name": "Alice"}],
        }
        alice.send_json(encrypted_message("demo", client_message_id="old-after-leave"))
        assert alice.receive_json()["code"] == "e2ee_not_ready"
        alice.send_json({"type": "ping"})
        assert alice.receive_json() == {"type": "pong"}

        with client.websocket_connect(
            socket_url(client_id="charlie", display_name="Charlie")
        ) as charlie:
            connected, _ = receive_initial(charlie)
            assert connected["e2ee_required"] is True
            assert connected["e2ee_public_keys"][0]["public_key_id"] == public_key_id(
                raw_public_key(1)
            )
            assert alice.receive_json()["action"] == "joined"

            charlie.send_json(hello(3))
            charlie_event = public_key_event(
                3,
                client_id="charlie",
                display_name="Charlie",
            )
            assert alice.receive_json() == charlie_event
            assert charlie.receive_json() == charlie_event

            alice.send_json(
                encrypted_message("demo", client_message_id="stale-pair")
            )
            assert alice.receive_json()["code"] == "e2ee_key_mismatch"

            current = encrypted_message(
                "demo",
                client_message_id="replacement-pair",
                key_markers=(1, 3),
            )
            alice.send_json(current)
            assert alice.receive_json()["type"] == "message_ack"
            delivered_to_alice = alice.receive_json()
            delivered_to_charlie = charlie.receive_json()
            assert delivered_to_alice == delivered_to_charlie
            assert delivered_to_alice["message"]["key_id"] == current["key_id"]

    history = client.get("/api/rooms/demo/messages").json()
    assert [message["client_message_id"] for message in history["messages"]] == [
        "replacement-pair"
    ]


def test_active_key_rotation_invalidates_old_pair_and_injects_current_sender_key(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            receive_initial(bob)
            assert alice.receive_json()["action"] == "joined"
            register_pair(alice, bob)

            alice.send_json(hello(1))
            repeated = public_key_event(
                1,
                client_id="alice",
                display_name="Alice",
            )
            assert alice.receive_json() == repeated
            assert bob.receive_json() == repeated

            alice.send_json(hello(3))
            rotated = public_key_event(
                3,
                client_id="alice",
                display_name="Alice",
            )
            assert alice.receive_json() == rotated
            assert bob.receive_json() == rotated

            alice.send_json(
                encrypted_message("demo", client_message_id="pre-rotation-pair")
            )
            assert alice.receive_json()["code"] == "e2ee_key_mismatch"

            current = encrypted_message(
                "demo",
                client_message_id="post-rotation-pair",
                key_markers=(2, 3),
            )
            alice.send_json(current)
            assert alice.receive_json()["type"] == "message_ack"
            event = alice.receive_json()
            assert bob.receive_json() == event
            assert event["message"]["sender_key_id"] == public_key_id(
                raw_public_key(3)
            )
            assert event["message"]["key_id"] == current["key_id"]


def test_maximum_encrypted_plaintext_size_fits_bounded_websocket_frame(
    database_path: Path,
) -> None:
    settings = phase4_settings(database_path)
    with TestClient(create_app(settings)) as client:
        with client.websocket_connect(socket_url()) as alice:
            receive_initial(alice)
            with client.websocket_connect(
                socket_url(client_id="bob", display_name="Bob")
            ) as bob:
                receive_initial(bob)
                assert alice.receive_json()["action"] == "joined"
                register_pair(alice, bob)

                largest = encrypted_message(
                    "demo",
                    client_message_id="max-payload",
                    ciphertext=b"x" * MAX_E2EE_CIPHERTEXT_BYTES,
                )
                assert len(json.dumps(largest).encode("utf-8")) < 8_192
                alice.send_json(largest)
                assert alice.receive_json()["type"] == "message_ack"
                assert alice.receive_json()["type"] == "encrypted_message"
                assert bob.receive_json()["type"] == "encrypted_message"

                too_large = {
                    **largest,
                    "client_message_id": "over-payload",
                    "iv": encode_base64url(b"9" * 12),
                    "ciphertext": encode_base64url(
                        b"x" * (MAX_E2EE_CIPHERTEXT_BYTES + 1)
                    ),
                }
                alice.send_json(too_large)
                assert alice.receive_json()["code"] == "validation_error"
