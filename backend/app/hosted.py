"""Single-service hosted entry point; the existing API and chat stay intact."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from starlette.datastructures import MutableHeaders
from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .main import app as api_app


# Match frontend/nginx.conf so the Docker deployment keeps the LAN UI's policy.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; "
        "font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    ),
}


class SecurityHeaders:
    """Wrap all HTTP responses, including application error responses."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    headers[name] = value
                if headers.get("content-type", "").startswith("text/html"):
                    headers["Cache-Control"] = "no-cache"
            await send(message)

        await self.app(scope, receive, send_with_headers)


class FrontendFiles(StaticFiles):
    """Serve the built frontend without turning missing API routes into HTML."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            # Real /ws/{room_id} routes are registered before this mount.
            await send({"type": "websocket.close", "code": 1008})
            return
        path = scope.get("path", "")
        if path in {"/api", "/ws"} or path.startswith(("/api/", "/ws/")):
            await JSONResponse({"detail": "Not Found"}, status_code=404)(
                scope, receive, send
            )
            return
        await super().__call__(scope, receive, send)


def mount_frontend(application: FastAPI, directory: Path) -> ASGIApp:
    """Append the static route after all existing HTTP and WebSocket routes."""
    application.mount("/", FrontendFiles(directory=directory, html=True), name="frontend")
    return SecurityHeaders(application)


def create_app() -> ASGIApp:
    """Uvicorn factory used only by the single-service deployment image."""
    if api_app.state.settings.deployment_mode != "hosted":
        raise RuntimeError("The hosted entry point requires DEPLOYMENT_MODE=hosted")
    return mount_frontend(api_app, Path(__file__).resolve().parent.parent / "static")
