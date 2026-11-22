"""FastAPI application for a bounded, two-user real-time chat starter."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re
import secrets
import weakref
from contextlib import suppress
from datetime import UTC, datetime
from typing import Annotated

from anyio import move_on_after
from fastapi import FastAPI, Path, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .attachments import create_attachment_router
from .bb84 import BB84Config, simulate_bb84
from .config import Settings
from .connections import E2EEPublicKeyAdvertisement, RoomConnectionManager
from .e2ee import pair_key_id, validate_p256_public_key
from .postprocessing import run_post_processing
from .repository import (
    E2EEIVReuseError,
    E2EENotEnabledError,
    E2EERequiredError,
    MessageIdConflictError,
    MessageRecord,
    SQLiteMessageRepository,
)
from .relay import RELAY_HEADER, PeerUnavailable, proxy_room_websocket
from .room_codes import InvalidInvitationRoomCode, decode_room_creator_ip
from .schemas import (
    BB84ControlCommand,
    BB84StartCommand,
    E2EEHelloCommand,
    EncryptedMessageCommand,
    HealthResponse,
    HistoryResponse,
    MessageCommand,
    NetworkInfoResponse,
    PingCommand,
    TypingCommand,
)

LOGGER = logging.getLogger(__name__)
IDENTIFIER_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
IDENTIFIER_RE = re.compile(IDENTIFIER_PATTERN)


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def error_event(
    code: str,
    message: str,
    *,
    client_message_id: str | None = None,
) -> dict[str, str]:
    event = {"type": "error", "code": code, "message": message}
    if client_message_id is not None:
        event["client_message_id"] = client_message_id
    return event


def public_messages(
    messages: list[MessageRecord],
    *,
    e2ee_required: bool,
) -> list[dict[str, object]]:
    """Serialize history while explicitly marking pre-lock plaintext."""

    return [
        message.as_dict(
            legacy_plaintext=e2ee_required and message.kind == "message"
        )
        for message in messages
    ]


def validate_identity(room_id: str, client_id: str, display_name: str) -> str | None:
    if not IDENTIFIER_RE.fullmatch(room_id):
        return "room_id must be 1-64 letters, numbers, underscores or hyphens"
    if not IDENTIFIER_RE.fullmatch(client_id):
        return "client_id must be 1-64 letters, numbers, underscores or hyphens"
    if not 1 <= len(display_name) <= 50 or display_name != display_name.strip():
        return "display_name must be 1-50 characters without outer whitespace"
    if any(ord(character) < 32 for character in display_name):
        return "display_name contains unsupported control characters"
    return None


def execute_bb84_pipeline(
    config: BB84Config,
    *,
    room_id: str,
    session_id: str,
) -> tuple[dict[str, object], dict[str, object]]:
    """Run simulation and private post-processing in one worker-thread scope."""

    simulation = simulate_bb84(config)
    try:
        public_simulation = simulation.public_payload()
        alice_candidate_bits, bob_candidate_bits = (
            simulation.consume_private_candidate_bits()
        )
        post_processing = run_post_processing(
            alice_candidate_bits,
            bob_candidate_bits,
            bb84_accepted=simulation.decision.status == "accepted",
            observed_qber=simulation.metrics.qber,
            room_id=room_id,
            session_id=session_id,
            teaching_seed=config.seed,
        )
        return public_simulation, post_processing.public_payload()
    finally:
        # This is idempotent after consume. It also covers an unexpected error
        # before ownership is transferred to the post-processing function.
        simulation.discard_private_candidate_bits()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    repository = SQLiteMessageRepository(settings.database_path)
    manager = RoomConnectionManager()
    active_bb84_rooms: set[str] = set()
    e2ee_room_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
        weakref.WeakValueDictionary()
    )

    def e2ee_room_lock(room_id: str) -> asyncio.Lock:
        lock = e2ee_room_locks.get(room_id)
        if lock is None:
            lock = asyncio.Lock()
            e2ee_room_locks[room_id] = lock
        return lock

    app = FastAPI(
        title="Secure Chat Starter API",
        version="0.4.0",
        description=(
            "Two-user chat with opaque browser-to-browser E2EE envelopes, plus "
            "a separate classical BB84 teaching simulation and redacted "
            "post-processing metrics. E2EE public keys are not authenticated."
        ),
    )
    app.state.settings = settings
    app.state.repository = repository
    app.state.connection_manager = manager
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
        max_age=600,
    )

    app.include_router(create_attachment_router(settings))

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> dict[str, str]:
        repository.ping()
        return {
            "status": "ok",
            "database": "ok",
            "service": "secure-chat-starter",
        }

    @app.get("/api/network", response_model=NetworkInfoResponse)
    def network_info() -> dict[str, object]:
        advertised_host = settings.lan_advertise_ip
        return {
            "mode": "hosted" if settings.deployment_mode == "hosted" else "lan" if advertised_host is not None else "localhost",
            "advertised_host": advertised_host,
            "port": settings.app_port,
            "ready": settings.deployment_mode == "hosted" or advertised_host is not None,
        }

    @app.get(
        "/api/rooms/{room_id}/messages",
        response_model=HistoryResponse,
        response_model_exclude_none=True,
    )
    async def room_history(
        room_id: Annotated[
            str,
            Path(min_length=1, max_length=64, pattern=IDENTIFIER_PATTERN),
        ],
        limit: Annotated[int, Query(ge=1)] = 50,
    ) -> dict[str, object]:
        if limit > settings.max_history_limit:
            limit = settings.max_history_limit
        messages = await run_in_threadpool(repository.list_messages, room_id, limit)
        e2ee_required = await run_in_threadpool(
            repository.is_e2ee_required,
            room_id,
        )
        return {
            "room_id": room_id,
            "messages": public_messages(messages, e2ee_required=e2ee_required),
            "participants": await manager.participants(room_id),
            "e2ee_required": e2ee_required,
        }

    @app.websocket("/ws/{room_id}")
    async def room_socket(
        websocket: WebSocket,
        room_id: str,
        client_id: str = Query(...),
        display_name: str = Query(...),
    ) -> None:
        await websocket.accept()
        origin = websocket.headers.get("origin")
        if (
            origin
            and "*" not in settings.allowed_origins
            and origin not in settings.allowed_origins
        ):
            await websocket.send_json(
                error_event("origin_not_allowed", "The WebSocket Origin is not allowed")
            )
            await websocket.close(code=4403, reason="origin not allowed")
            return
        identity_error = validate_identity(room_id, client_id, display_name)
        if identity_error:
            await websocket.send_json(error_event("invalid_identity", identity_error))
            await websocket.close(code=4400, reason="invalid identity")
            return

        try:
            creator_ip = decode_room_creator_ip(room_id)
        except InvalidInvitationRoomCode:
            await websocket.send_json(
                error_event(
                    "invalid_room_code",
                    "The invitation room code does not contain a valid private host address",
                )
            )
            await websocket.close(code=4400, reason="invalid invitation room code")
            return

        if creator_ip is not None and settings.deployment_mode == "hosted":
            await websocket.send_json(error_event(
                "lan_relay_disabled",
                "LAN invitations are disabled on this hosted server. Create a new room on this website.",
            ))
            await websocket.close(code=4400, reason="LAN relay disabled")
            return

        if creator_ip is not None and creator_ip != settings.lan_advertise_ip:
            relay_error = error_event(
                "peer_unreachable",
                "The room host could not be reached on the local network",
            )
            if websocket.headers.get(RELAY_HEADER):
                await websocket.send_json(relay_error)
                await websocket.close(code=4410, reason="relay loop prevented")
                return
            try:
                await proxy_room_websocket(
                    websocket,
                    creator_ip=creator_ip,
                    port=settings.app_port,
                    room_id=room_id,
                    client_id=client_id,
                    display_name=display_name,
                    max_frame_bytes=settings.max_websocket_event_bytes,
                )
            except PeerUnavailable:
                LOGGER.warning(
                    "LAN room creator %s:%s is unreachable",
                    creator_ip,
                    settings.app_port,
                )
                with suppress(Exception):
                    await websocket.send_json(relay_error)
                    await websocket.close(code=4410, reason="peer unreachable")
            else:
                with suppress(Exception):
                    await websocket.close(code=1000)
            return

        joined = await manager.join(room_id, client_id, display_name, websocket)
        if joined.status != "joined":
            code = "room_full" if joined.status == "room_full" else joined.status
            message = (
                "This room already has two distinct clients"
                if code == "room_full"
                else "This client_id is already connected to the room"
            )
            await websocket.send_json(error_event(code, message))
            await websocket.close(
                code=4403 if code == "room_full" else 4409,
                reason=message,
            )
            return

        try:
            history = await run_in_threadpool(
                repository.list_messages,
                room_id,
                settings.default_history_limit,
            )
            e2ee_required = await run_in_threadpool(
                repository.is_e2ee_required,
                room_id,
            )
            advertised_keys = await manager.e2ee_public_keys(
                room_id,
                exclude_client_id=client_id,
            )
            await manager.send_to(
                room_id,
                client_id,
                {
                    "type": "connected",
                    "client_id": client_id,
                    "room_id": room_id,
                    "participants": joined.participants,
                    "messages": public_messages(
                        history,
                        e2ee_required=e2ee_required,
                    ),
                    "e2ee_required": e2ee_required,
                    "e2ee_public_keys": [
                        key.as_connected_record() for key in advertised_keys
                    ],
                },
            )
            await manager.broadcast(
                room_id,
                {
                    "type": "presence",
                    "action": "joined",
                    "client_id": client_id,
                    "display_name": display_name,
                    "participants": joined.participants,
                },
            )

            while True:
                packet = await websocket.receive()
                if packet["type"] == "websocket.disconnect":
                    break
                raw = packet.get("text")
                if raw is None:
                    await manager.send_to(
                        room_id,
                        client_id,
                        error_event("text_frames_only", "Only JSON text frames are accepted"),
                    )
                    continue
                if len(raw.encode("utf-8")) > settings.max_websocket_event_bytes:
                    await manager.send_to(
                        room_id,
                        client_id,
                        error_event("event_too_large", "WebSocket event is too large"),
                    )
                    continue
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    await manager.send_to(
                        room_id,
                        client_id,
                        error_event("invalid_json", "Event must contain valid JSON"),
                    )
                    continue
                if not isinstance(payload, dict):
                    await manager.send_to(
                        room_id,
                        client_id,
                        error_event("invalid_event", "Event must be a JSON object"),
                    )
                    continue

                event_type = payload.get("type")
                event_lock: asyncio.Lock | None = None
                if isinstance(event_type, str) and event_type in {
                    "e2ee_hello",
                    "encrypted_message",
                    "bb84_control",
                }:
                    # Keep a key rotation from interleaving between envelope
                    # validation and persistence/broadcast for the same room.
                    event_lock = e2ee_room_lock(room_id)
                    await event_lock.acquire()
                try:
                    if event_type == "message":
                        command = MessageCommand.model_validate(payload)
                        if len(command.text) > settings.max_message_length:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "message_too_long",
                                    f"Message exceeds {settings.max_message_length} characters",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        sent_at = utc_now()
                        try:
                            message, created = await run_in_threadpool(
                                repository.create_message,
                                room_id=room_id,
                                client_message_id=command.client_message_id,
                                sender_id=client_id,
                                sender_name=display_name,
                                text=command.text,
                                sent_at=sent_at,
                            )
                        except E2EERequiredError:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_required",
                                    "This room now accepts encrypted-message envelopes only",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        await manager.send_to(
                            room_id,
                            client_id,
                            {
                                "type": "message_ack",
                                "client_message_id": command.client_message_id,
                                "message_id": str(message.id),
                                "sent_at": message.sent_at,
                                "duplicate": not created,
                            },
                        )
                        if created:
                            await manager.broadcast(
                                room_id,
                                {"type": "message", "message": message.as_dict()},
                            )
                    elif event_type == "e2ee_hello":
                        command = E2EEHelloCommand.model_validate(payload)
                        raw_public_key = validate_p256_public_key(command.public_key)
                        advertisement = E2EEPublicKeyAdvertisement(
                            client_id=client_id,
                            display_name=display_name,
                            version=command.version,
                            algorithm=command.algorithm,
                            public_key_id=command.public_key_id,
                            public_key=command.public_key,
                            public_key_bytes=raw_public_key,
                        )
                        await run_in_threadpool(
                            repository.require_e2ee,
                            room_id,
                            utc_now(),
                        )
                        registration = await manager.register_e2ee_public_key(
                            room_id,
                            client_id,
                            advertisement,
                        )
                        if registration == "peer_key_conflict":
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_public_key_conflict",
                                    "Each participant must advertise a distinct public key",
                                ),
                            )
                            continue
                        if registration != "registered":
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_not_ready",
                                    "The browser key could not be registered for this connection",
                                ),
                            )
                            continue
                        await manager.broadcast(
                            room_id,
                            advertisement.as_event(),
                        )
                    elif event_type == "encrypted_message":
                        command = EncryptedMessageCommand.model_validate(payload)
                        advertisements = await manager.e2ee_key_pair(room_id)
                        if advertisements is None:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_not_ready",
                                    "Both active browsers must advertise current public keys",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        sender_advertisement = next(
                            (
                                value
                                for value in advertisements
                                if value.client_id == client_id
                            ),
                            None,
                        )
                        if sender_advertisement is None:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_not_ready",
                                    "The sender has not advertised a current public key",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        expected_key_id = pair_key_id(
                            room_id,
                            [
                                value.public_key_bytes
                                for value in advertisements
                            ],
                        )
                        if not hmac.compare_digest(command.key_id, expected_key_id):
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_key_mismatch",
                                    "The encrypted envelope does not use the current browser-key pair",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        sent_at = utc_now()
                        try:
                            message, created = await run_in_threadpool(
                                repository.create_encrypted_message,
                                room_id=room_id,
                                client_message_id=command.client_message_id,
                                sender_id=client_id,
                                sender_name=display_name,
                                sent_at=sent_at,
                                version=command.version,
                                algorithm=command.algorithm,
                                key_id=command.key_id,
                                sender_key_id=sender_advertisement.public_key_id,
                                iv=command.iv,
                                ciphertext=command.ciphertext,
                            )
                        except MessageIdConflictError:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "message_id_conflict",
                                    "client_message_id was already used for another envelope",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        except E2EEIVReuseError:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_iv_reuse",
                                    "This AES-GCM IV was already used with the current sending key",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        except E2EENotEnabledError:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "e2ee_not_ready",
                                    "This room has not enabled encrypted-message envelopes",
                                    client_message_id=command.client_message_id,
                                ),
                            )
                            continue
                        await manager.send_to(
                            room_id,
                            client_id,
                            {
                                "type": "message_ack",
                                "client_message_id": command.client_message_id,
                                "message_id": str(message.id),
                                "sent_at": message.sent_at,
                                "duplicate": not created,
                            },
                        )
                        if created:
                            await manager.broadcast(
                                room_id,
                                {
                                    "type": "encrypted_message",
                                    "message": message.as_dict(),
                                },
                            )
                    elif event_type == "bb84_control":
                        command = BB84ControlCommand.model_validate(payload)
                        if command.room_id != room_id:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event("bb84_control_invalid", "Control packet room does not match this connection"),
                            )
                            continue
                        advertisements = await manager.e2ee_key_pair(room_id)
                        if advertisements is None:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event("e2ee_not_ready", "Both current browser keys are required"),
                            )
                            continue
                        sender_advertisement = next(
                            (item for item in advertisements if item.client_id == client_id),
                            None,
                        )
                        recipient_advertisement = next(
                            (item for item in advertisements if item.client_id != client_id),
                            None,
                        )
                        if sender_advertisement is None or recipient_advertisement is None:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event("e2ee_not_ready", "Current browser keys are unavailable"),
                            )
                            continue
                        expected_pair_id = pair_key_id(
                            room_id,
                            [item.public_key_bytes for item in advertisements],
                        )
                        if not (
                            hmac.compare_digest(command.pair_key_id, expected_pair_id)
                            and hmac.compare_digest(command.sender_key_id, sender_advertisement.public_key_id)
                            and hmac.compare_digest(command.recipient_key_id, recipient_advertisement.public_key_id)
                        ):
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event("bb84_control_invalid", "Control packet does not match the current browser-key pair"),
                            )
                            continue
                        # The backend validates routing only. The encrypted
                        # payload is neither opened, persisted, nor logged.
                        forwarded = await manager.send_to(
                            room_id,
                            recipient_advertisement.client_id,
                            command.model_dump(mode="json"),
                        )
                        if not forwarded:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event("peer_unreachable", "The peer browser could not receive the control packet"),
                            )
                    elif event_type == "typing":
                        command = TypingCommand.model_validate(payload)
                        await manager.broadcast(
                            room_id,
                            {
                                "type": "typing",
                                "client_id": client_id,
                                "display_name": display_name,
                                "is_typing": command.is_typing,
                            },
                            exclude_client_id=client_id,
                        )
                    elif event_type == "ping":
                        PingCommand.model_validate(payload)
                        await manager.send_to(room_id, client_id, {"type": "pong"})
                    elif event_type == "bb84_start":
                        command = BB84StartCommand.model_validate(payload)
                        if room_id in active_bb84_rooms:
                            await manager.send_to(
                                room_id,
                                client_id,
                                error_event(
                                    "bb84_busy",
                                    "A BB84 simulation is already running for this room",
                                ),
                            )
                            continue

                        # All room handlers share one event loop. This check/add
                        # section contains no await, so only one run can claim a
                        # room while simulations for other rooms remain independent.
                        active_bb84_rooms.add(room_id)
                        try:
                            session_id = f"sim_{secrets.token_hex(12)}"
                            config = BB84Config(
                                    qubit_count=command.qubit_count,
                                    noise_probability=command.noise_probability,
                                    intercept_probability=command.intercept_probability,
                                    sample_ratio=command.sample_ratio,
                                    qber_threshold=command.qber_threshold,
                                    seed=command.seed,
                                )
                            simulation_payload, post_processing_payload = (
                                await run_in_threadpool(
                                    execute_bb84_pipeline,
                                    config,
                                    room_id=room_id,
                                    session_id=session_id,
                                )
                            )
                            await manager.broadcast(
                                room_id,
                                {
                                    "type": "bb84_result",
                                    "session_id": session_id,
                                    "started_by": client_id,
                                    "created_at": utc_now(),
                                    "simulation_only": True,
                                    "chat_encryption_active": False,
                                    **simulation_payload,
                                    "post_processing": post_processing_payload,
                                },
                            )
                        finally:
                            active_bb84_rooms.discard(room_id)
                    else:
                        await manager.send_to(
                            room_id,
                            client_id,
                            error_event("unsupported_event", "Unsupported event type"),
                        )
                except ValidationError:
                    rejected_message_id = payload.get("client_message_id")
                    if not (
                        event_type in {"message", "encrypted_message"}
                        and isinstance(rejected_message_id, str)
                        and 1 <= len(rejected_message_id) <= 64
                    ):
                        rejected_message_id = None
                    await manager.send_to(
                        room_id,
                        client_id,
                        error_event(
                            "validation_error",
                            "Event payload is invalid",
                            client_message_id=rejected_message_id,
                        ),
                    )
                finally:
                    if event_lock is not None:
                        event_lock.release()
        except WebSocketDisconnect:
            pass
        except Exception:
            LOGGER.exception("Unexpected WebSocket failure in room %s", room_id)
            await manager.send_to(
                room_id,
                client_id,
                error_event("internal_error", "The server could not process the event"),
            )
        finally:
            # ASGI task cancellation must not leave a stale participant/key in
            # the room. Shield cleanup, but bound a slow peer's presence send.
            with move_on_after(2, shield=True):
                removed, participants = await manager.leave(room_id, client_id, websocket)
                if removed:
                    await manager.broadcast(
                        room_id,
                        {
                            "type": "presence",
                            "action": "left",
                            "client_id": client_id,
                            "display_name": display_name,
                            "participants": participants,
                        },
                    )

    return app


app = create_app()
