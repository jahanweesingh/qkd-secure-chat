"""In-process room presence and safe WebSocket fan-out."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Literal

from fastapi import WebSocket


@dataclass(slots=True)
class Connection:
    client_id: str
    display_name: str
    websocket: WebSocket
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    e2ee_public_key: "E2EEPublicKeyAdvertisement | None" = None

    def participant(self) -> dict[str, str]:
        return {"client_id": self.client_id, "display_name": self.display_name}


@dataclass(frozen=True, slots=True)
class E2EEPublicKeyAdvertisement:
    """Validated public metadata for one currently connected browser."""

    client_id: str
    display_name: str
    version: str
    algorithm: str
    public_key_id: str
    public_key: str
    public_key_bytes: bytes = field(repr=False)

    def as_event(self) -> dict[str, str]:
        return {
            "type": "e2ee_public_key",
            "client_id": self.client_id,
            "display_name": self.display_name,
            "version": self.version,
            "algorithm": self.algorithm,
            "public_key_id": self.public_key_id,
            "public_key": self.public_key,
        }

    def as_connected_record(self) -> dict[str, str]:
        value = self.as_event()
        del value["type"]
        return value


@dataclass(frozen=True, slots=True)
class JoinResult:
    status: Literal["joined", "room_full", "client_already_connected"]
    participants: list[dict[str, str]]


class RoomConnectionManager:
    ROOM_CAPACITY = 2

    def __init__(self) -> None:
        self._rooms: dict[str, dict[str, Connection]] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def _ordered(room: dict[str, Connection]) -> list[dict[str, str]]:
        return [room[key].participant() for key in sorted(room)]

    async def join(
        self,
        room_id: str,
        client_id: str,
        display_name: str,
        websocket: WebSocket,
    ) -> JoinResult:
        async with self._lock:
            room = self._rooms.setdefault(room_id, {})
            if client_id in room:
                return JoinResult("client_already_connected", self._ordered(room))
            if len(room) >= self.ROOM_CAPACITY:
                return JoinResult("room_full", self._ordered(room))
            room[client_id] = Connection(client_id, display_name, websocket)
            return JoinResult("joined", self._ordered(room))

    async def leave(
        self, room_id: str, client_id: str, websocket: WebSocket
    ) -> tuple[bool, list[dict[str, str]]]:
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                return False, []
            connection = room.get(client_id)
            if connection is None or connection.websocket is not websocket:
                return False, self._ordered(room)
            del room[client_id]
            participants = self._ordered(room)
            if not room:
                del self._rooms[room_id]
            return True, participants

    async def participants(self, room_id: str) -> list[dict[str, str]]:
        async with self._lock:
            return self._ordered(self._rooms.get(room_id, {}))

    async def register_e2ee_public_key(
        self,
        room_id: str,
        client_id: str,
        advertisement: E2EEPublicKeyAdvertisement,
    ) -> Literal["registered", "client_missing", "peer_key_conflict"]:
        """Atomically register one active browser's current public key."""

        async with self._lock:
            room = self._rooms.get(room_id)
            connection = room.get(client_id) if room is not None else None
            if connection is None:
                return "client_missing"
            if any(
                other_id != client_id
                and other.e2ee_public_key is not None
                and other.e2ee_public_key.public_key_id
                == advertisement.public_key_id
                for other_id, other in room.items()
            ):
                return "peer_key_conflict"
            connection.e2ee_public_key = advertisement
            return "registered"

    async def e2ee_public_keys(
        self,
        room_id: str,
        *,
        exclude_client_id: str | None = None,
    ) -> list[E2EEPublicKeyAdvertisement]:
        async with self._lock:
            room = self._rooms.get(room_id, {})
            return [
                advertisement
                for current_id in sorted(room)
                if current_id != exclude_client_id
                and (advertisement := room[current_id].e2ee_public_key) is not None
            ]

    async def e2ee_key_pair(
        self,
        room_id: str,
    ) -> tuple[E2EEPublicKeyAdvertisement, E2EEPublicKeyAdvertisement] | None:
        """Return exactly two current advertisements, or ``None`` until ready."""

        async with self._lock:
            room = self._rooms.get(room_id, {})
            if len(room) != self.ROOM_CAPACITY:
                return None
            advertisements = [
                room[current_id].e2ee_public_key for current_id in sorted(room)
            ]
            if any(value is None for value in advertisements):
                return None
            left, right = advertisements
            assert left is not None and right is not None
            return left, right

    async def _send(self, connection: Connection, event: dict[str, object]) -> bool:
        try:
            async with connection.send_lock:
                await connection.websocket.send_json(event)
            return True
        except Exception:
            return False

    async def send_to(
        self, room_id: str, client_id: str, event: dict[str, object]
    ) -> bool:
        async with self._lock:
            connection = self._rooms.get(room_id, {}).get(client_id)
        return False if connection is None else await self._send(connection, event)

    async def broadcast(
        self,
        room_id: str,
        event: dict[str, object],
        *,
        exclude_client_id: str | None = None,
    ) -> None:
        async with self._lock:
            connections = [
                connection
                for client_id, connection in self._rooms.get(room_id, {}).items()
                if client_id != exclude_client_id
            ]
        if connections:
            await asyncio.gather(
                *(self._send(connection, event) for connection in connections)
            )
