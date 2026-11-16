"""The combined host must preserve API/WS routing and browser protections."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.hosted import SECURITY_HEADERS, mount_frontend
from app.main import create_app

from .conftest import receive_initial, socket_url


ORIGIN = "https://chat.example.test"


@pytest.fixture
def hosted_application(tmp_path: Path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><main>Hosted chat</main>")
    (static / "assets").mkdir()
    (static / "assets" / "app.js").write_text("console.log('fixture');")
    # Even a matching static path must never take over the reserved API namespace.
    (static / "api").mkdir()
    (static / "api" / "index.html").write_text("This is not an API response")
    api = create_app(Settings(
        database_path=str(tmp_path / "chat.db"),
        deployment_mode="hosted",
        allowed_origins=(ORIGIN,),
    ))
    return mount_frontend(api, static)


@pytest.mark.parametrize("path,status,content_type", [
    ("/", 200, "text/html"),
    ("/assets/app.js", 200, "javascript"),
    ("/api/health", 200, "application/json"),
    ("/api", 404, "application/json"),
    ("/api/missing", 404, "application/json"),
    ("/ws", 404, "application/json"),
    ("/assets/missing.js", 404, "application/json"),
])
def test_hosted_static_and_api_responses_keep_security_headers(
    hosted_application, path, status, content_type
):
    with TestClient(hosted_application) as client:
        response = client.get(path)
    assert response.status_code == status
    assert content_type in response.headers["content-type"]
    for name, value in SECURITY_HEADERS.items():
        assert response.headers[name] == value
    if path == "/":
        assert "Hosted chat" in response.text
        assert response.headers["cache-control"] == "no-cache"
    if path.startswith("/api"):
        assert "Hosted chat" not in response.text
        assert "This is not an API response" not in response.text


def test_hosted_existing_websocket_route_precedes_static_mount(hosted_application):
    with TestClient(hosted_application) as client:
        with client.websocket_connect(socket_url(), headers={"Origin": ORIGIN}) as socket:
            connected, presence = receive_initial(socket)
            assert connected["room_id"] == "demo"
            assert presence["type"] == "presence"
            socket.send_json({"type": "ping"})
            assert socket.receive_json()["type"] == "pong"


def test_hosted_unknown_websocket_path_is_closed(hosted_application):
    with TestClient(hosted_application) as client:
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect("/unknown/path", headers={"Origin": ORIGIN}):
                pass
    assert refused.value.code == 1008


def test_hosted_security_headers_also_cover_unhandled_errors(tmp_path: Path):
    static = tmp_path / "static"
    static.mkdir()
    api = create_app(Settings(database_path=str(tmp_path / "error.db")))

    @api.get("/api/failure-fixture")
    def failure_fixture():
        raise RuntimeError("test-only failure")

    with TestClient(mount_frontend(api, static), raise_server_exceptions=False) as client:
        response = client.get("/api/failure-fixture")
    assert response.status_code == 500
    for name, value in SECURITY_HEADERS.items():
        assert response.headers[name] == value


def test_hosted_missing_build_fails_instead_of_starting_partial_service(tmp_path: Path):
    api = create_app(Settings(database_path=str(tmp_path / "missing.db")))
    with pytest.raises(RuntimeError, match="does not exist"):
        mount_frontend(api, tmp_path / "missing-static")
