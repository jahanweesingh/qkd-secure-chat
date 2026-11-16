"""Bounded, single-hop WebSocket relay for same-LAN invitation rooms."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from urllib.parse import quote, urlencode

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from .config import normalize_rfc1918_ipv4

PEER_CONNECT_TIMEOUT_SECONDS = 3.0
PEER_CLOSE_TIMEOUT_SECONDS = 1.0
RELAY_HEADER = "X-Secure-Chat-Relay"
# Client commands stay tightly bounded by Settings.max_websocket_event_bytes.
# A creator's initial connected event can legitimately contain 50 bounded
# history records, so the peer-to-browser direction needs a separate cap.
MAX_RELAY_SERVER_FRAME_BYTES = 512 * 1_024


class PeerUnavailable(ConnectionError):
    """The creator backend could not be reached or could not relay the room."""


def peer_websocket_url(
    creator_ip: str,
    port: int,
    room_id: str,
    client_id: str,
    display_name: str,
) -> str:
    safe_creator_ip = normalize_rfc1918_ipv4(creator_ip)
    if safe_creator_ip is None:
        raise ValueError("creator_ip must be an RFC1918 IPv4 address")
    if not 1 <= port <= 65_535:
        raise ValueError("port must be between 1 and 65535")
    query = urlencode({"client_id": client_id, "display_name": display_name})
    return f"ws://{safe_creator_ip}:{port}/ws/{quote(room_id, safe='')}?{query}"


async def _browser_to_peer(
    browser: WebSocket,
    peer: object,
    max_frame_bytes: int,
) -> None:
    try:
        while True:
            packet = await browser.receive()
            if packet["type"] == "websocket.disconnect":
                return

            frame = packet.get("text")
            if frame is not None:
                frame_size = len(frame.encode("utf-8"))
            else:
                frame = packet.get("bytes")
                if frame is None:
                    continue
                frame_size = len(frame)

            if frame_size > max_frame_bytes:
                await browser.send_json(
                    {
                        "type": "error",
                        "code": "event_too_large",
                        "message": "WebSocket event is too large",
                    }
                )
                continue
            await peer.send(frame)  # type: ignore[attr-defined]
    except (ConnectionClosed, WebSocketDisconnect):
        return


async def _peer_to_browser(
    peer: object,
    browser: WebSocket,
    max_server_frame_bytes: int,
) -> None:
    try:
        async for frame in peer:  # type: ignore[attr-defined]
            frame_size = (
                len(frame.encode("utf-8")) if isinstance(frame, str) else len(frame)
            )
            if frame_size > max_server_frame_bytes:
                await browser.send_json(
                    {
                        "type": "error",
                        "code": "event_too_large",
                        "message": "Peer WebSocket event is too large",
                    }
                )
                return
            if isinstance(frame, str):
                await browser.send_text(frame)
            else:
                await browser.send_bytes(frame)
    except (ConnectionClosed, WebSocketDisconnect):
        return


async def proxy_room_websocket(
    browser: WebSocket,
    *,
    creator_ip: str,
    port: int,
    room_id: str,
    client_id: str,
    display_name: str,
    max_frame_bytes: int,
) -> None:
    """Relay one accepted browser WebSocket to its invitation creator."""

    url = peer_websocket_url(creator_ip, port, room_id, client_id, display_name)
    try:
        async with connect(
            url,
            additional_headers={RELAY_HEADER: "1"},
            open_timeout=PEER_CONNECT_TIMEOUT_SECONDS,
            close_timeout=PEER_CLOSE_TIMEOUT_SECONDS,
            max_size=MAX_RELAY_SERVER_FRAME_BYTES,
            max_queue=4,
            compression=None,
            proxy=None,
            ping_interval=20,
            ping_timeout=10,
            user_agent_header="BB84-Secure-Chat-Relay/1",
        ) as peer:
            browser_task = asyncio.create_task(
                _browser_to_peer(browser, peer, max_frame_bytes)
            )
            peer_task = asyncio.create_task(
                _peer_to_browser(peer, browser, MAX_RELAY_SERVER_FRAME_BYTES)
            )
            done, pending = await asyncio.wait(
                {browser_task, peer_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in pending:
                with suppress(asyncio.CancelledError):
                    await task
            for task in done:
                task.result()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise PeerUnavailable from exc
