"""Bounded opaque attachment storage. The server never receives file keys or names."""

from __future__ import annotations

import asyncio
import hmac
import http.client
import re
import sqlite3
from contextlib import contextmanager
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from fastapi.responses import JSONResponse

from .config import Settings, normalize_rfc1918_ipv4
from .relay import RELAY_HEADER
from .room_codes import InvalidInvitationRoomCode, decode_room_creator_ip

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_CIPHERTEXT_BYTES = MAX_FILE_BYTES + 16
MAX_ROOM_BYTES = 64 * 1024 * 1024
MAX_ROOM_ATTACHMENTS = 32
MAX_STORE_BYTES = 512 * 1024 * 1024
ROOM_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
ATTACHMENT_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
OPAQUE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "attachment",
}


class AttachmentStore:
    """SQLite transactions make quota and immutable-ID checks atomic across workers."""

    def __init__(self, database_path: str) -> None:
        self.database_path = database_path
        with self.connect() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS encrypted_attachments (
                    room_id TEXT NOT NULL REFERENCES room_security(room_id),
                    attachment_id TEXT NOT NULL,
                    ciphertext BLOB NOT NULL,
                    ciphertext_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    PRIMARY KEY (room_id, attachment_id),
                    CHECK (ciphertext_bytes = length(ciphertext)),
                    CHECK (ciphertext_bytes BETWEEN 17 AND 10485776)
                )"""
            )

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def put(self, room_id: str, attachment_id: str, ciphertext: bytes) -> bool:
        if not 17 <= len(ciphertext) <= MAX_CIPHERTEXT_BYTES:
            raise HTTPException(413, "Attachment size is outside the supported limit")
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute(
                "SELECT 1 FROM room_security WHERE room_id = ? AND e2ee_required = 1",
                (room_id,),
            ).fetchone():
                raise HTTPException(409, "Set up room encryption before sharing files")
            existing = connection.execute(
                "SELECT ciphertext FROM encrypted_attachments WHERE room_id = ? AND attachment_id = ?",
                (room_id, attachment_id),
            ).fetchone()
            if existing:
                if not hmac.compare_digest(existing[0], ciphertext):
                    raise HTTPException(409, "Attachment ID already belongs to different content")
                return False
            count, room_bytes = connection.execute(
                "SELECT count(*), coalesce(sum(ciphertext_bytes), 0) FROM encrypted_attachments WHERE room_id = ?",
                (room_id,),
            ).fetchone()
            total_bytes = connection.execute(
                "SELECT coalesce(sum(ciphertext_bytes), 0) FROM encrypted_attachments"
            ).fetchone()[0]
            if count >= MAX_ROOM_ATTACHMENTS or room_bytes + len(ciphertext) > MAX_ROOM_BYTES:
                raise HTTPException(413, "This room's attachment storage is full")
            if total_bytes + len(ciphertext) > MAX_STORE_BYTES:
                raise HTTPException(413, "Attachment storage is full on this server")
            connection.execute(
                "INSERT INTO encrypted_attachments (room_id, attachment_id, ciphertext, ciphertext_bytes) VALUES (?, ?, ?, ?)",
                (room_id, attachment_id, ciphertext, len(ciphertext)),
            )
        return True

    def get(self, room_id: str, attachment_id: str) -> bytes:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT ciphertext FROM encrypted_attachments WHERE room_id = ? AND attachment_id = ?",
                (room_id, attachment_id),
            ).fetchone()
        if row is None:
            raise HTTPException(404, "Encrypted attachment not found")
        return row[0]


def relay_attachment(
    creator_ip: str, port: int, room_id: str, attachment_id: str,
    method: str, ciphertext: bytes | None,
) -> tuple[int, bytes]:
    """One fixed private target, no redirects/proxy environment, bounded response."""
    try:
        target = normalize_rfc1918_ipv4(creator_ip)
    except ValueError as exc:
        raise HTTPException(502, "Invalid room host") from exc
    if target is None or not 1 <= port <= 65535:
        raise HTTPException(502, "Invalid room host")
    path = f"/api/rooms/{quote(room_id, safe='')}/attachments/{quote(attachment_id, safe='')}"
    connection = http.client.HTTPConnection(target, port, timeout=15)
    try:
        connection.request(method, path, body=ciphertext, headers={
            RELAY_HEADER: "1", "Content-Type": "application/octet-stream",
        })
        response = connection.getresponse()
        if response.status not in (200, 201):
            # Do not reflect an arbitrary peer response or follow redirects.
            status = response.status if response.status in (400, 403, 404, 409, 413, 415, 422, 429) else 502
            detail = {
                404: "Encrypted attachment not found on the room host",
                409: "Room encryption is not ready or the attachment ID conflicts",
                413: "Attachment is too large or room host storage is full",
            }.get(status, "The room host could not process this attachment")
            raise HTTPException(status, detail)
        if method == "GET":
            if response.getheader("Content-Type", "").split(";", 1)[0] != "application/octet-stream":
                raise HTTPException(502, "Invalid attachment response from room host")
            payload = response.read(MAX_CIPHERTEXT_BYTES + 1)
            if not 17 <= len(payload) <= MAX_CIPHERTEXT_BYTES:
                raise HTTPException(502, "Invalid attachment size from room host")
            return 200, payload
        # Upload acknowledgements contain no material and are constructed locally.
        return response.status, b""
    except (OSError, http.client.HTTPException) as exc:
        raise HTTPException(502, "The room host could not be reached") from exc
    finally:
        connection.close()


def create_attachment_router(settings: Settings) -> APIRouter:
    router = APIRouter()
    store = AttachmentStore(settings.database_path)
    active_requests = asyncio.Semaphore(4)

    def validate_route(request: Request, room_id: str, attachment_id: str) -> str | None:
        if not re.fullmatch(ROOM_PATTERN, room_id) or not re.fullmatch(ATTACHMENT_PATTERN, attachment_id):
            raise HTTPException(422, "Invalid room or attachment identifier")
        origin = request.headers.get("origin")
        if origin and "*" not in settings.allowed_origins and origin not in settings.allowed_origins:
            raise HTTPException(403, "Origin is not allowed")
        try:
            creator_ip = decode_room_creator_ip(room_id)
        except InvalidInvitationRoomCode as exc:
            raise HTTPException(422, "Invalid private room host") from exc
        if creator_ip is not None and settings.deployment_mode == "hosted":
            raise HTTPException(403, "LAN invitations are disabled on this hosted server")
        if creator_ip is not None and creator_ip != settings.lan_advertise_ip:
            if request.headers.get(RELAY_HEADER):
                raise HTTPException(502, "Attachment relay loop prevented")
            return creator_ip
        return None

    @router.post("/api/rooms/{room_id}/attachments/{attachment_id}")
    async def upload(request: Request, room_id: str, attachment_id: str):
        creator_ip = validate_route(request, room_id, attachment_id)
        if request.headers.get("content-type", "").split(";", 1)[0] != "application/octet-stream":
            raise HTTPException(415, "Only opaque encrypted bytes are accepted")
        length = request.headers.get("content-length")
        if length is not None:
            try:
                valid_length = 17 <= int(length) <= MAX_CIPHERTEXT_BYTES
            except ValueError:
                valid_length = False
            if not valid_length:
                raise HTTPException(413, "Attachment size is outside the supported limit")
        if active_requests.locked():
            raise HTTPException(429, "Attachment service is busy; retry shortly")
        async with active_requests:
            body = bytearray()
            try:
                async with asyncio.timeout(30):
                    async for chunk in request.stream():
                        if len(body) + len(chunk) > MAX_CIPHERTEXT_BYTES:
                            raise HTTPException(413, "Attachment is larger than 10 MiB")
                        body.extend(chunk)
            except TimeoutError as exc:
                raise HTTPException(408, "Attachment upload timed out") from exc
            except ClientDisconnect as exc:
                raise HTTPException(400, "Attachment upload was interrupted") from exc
            ciphertext = bytes(body)
            del body
            if len(ciphertext) < 17:
                raise HTTPException(413, "Attachment is empty or invalid")
            if creator_ip is not None:
                status, _ = await run_in_threadpool(
                    relay_attachment, creator_ip, settings.app_port,
                    room_id, attachment_id, "POST", ciphertext,
                )
            else:
                created = await run_in_threadpool(store.put, room_id, attachment_id, ciphertext)
                status = 201 if created else 200
            return JSONResponse(
                {"attachment_id": attachment_id, "ciphertext_bytes": len(ciphertext)},
                status_code=status, headers={"Cache-Control": "no-store"},
            )

    @router.get("/api/rooms/{room_id}/attachments/{attachment_id}")
    async def download(request: Request, room_id: str, attachment_id: str):
        creator_ip = validate_route(request, room_id, attachment_id)
        if active_requests.locked():
            raise HTTPException(429, "Attachment service is busy; retry shortly")
        async with active_requests:
            if creator_ip is not None:
                _, ciphertext = await run_in_threadpool(
                    relay_attachment, creator_ip, settings.app_port,
                    room_id, attachment_id, "GET", None,
                )
            else:
                ciphertext = await run_in_threadpool(store.get, room_id, attachment_id)
            return Response(ciphertext, media_type="application/octet-stream", headers=OPAQUE_HEADERS)

    return router
