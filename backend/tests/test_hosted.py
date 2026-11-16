"""Hosted deployment must keep chat local and never dial private LAN targets."""

from dataclasses import replace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app

from .conftest import receive_initial, socket_url
from .test_e2ee import encrypted_message, phase4_settings, register_pair


ORIGIN = "https://chat.example.test"
LAN_ROOM = "QKD-0123456789ABCDEF-30AG09A"


@pytest.fixture
def hosted_settings(database_path):
    return replace(
        phase4_settings(database_path),
        deployment_mode="hosted",
        allowed_origins=(ORIGIN,),
    )


def test_hosted_settings_require_explicit_origins_in_environment(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_MODE", "hosted")
    monkeypatch.delenv("LAN_ADVERTISE_IP", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    with pytest.raises(ValueError, match="explicit ALLOWED_ORIGINS"):
        Settings.from_env()
    with pytest.raises(ValueError, match="explicit ALLOWED_ORIGINS"):
        Settings(deployment_mode="hosted")

    monkeypatch.setenv("ALLOWED_ORIGINS", f"{ORIGIN}, https://second.example.test")
    settings = Settings.from_env()
    assert settings.deployment_mode == "hosted"
    assert settings.lan_advertise_ip is None
    assert settings.allowed_origins == (ORIGIN, "https://second.example.test")


@pytest.mark.parametrize("origins", [
    (), ("",), ("*",), ("https://*.example.test",),
    ("https://chat.example.test/",), ("https://chat.example.test/path",),
    ("https://chat.example.test?query",), ("https://chat.example.test#fragment",),
    ("https://chat.example.test?",), ("https://chat.example.test#",),
    ("https://user:password@chat.example.test",), ("ws://chat.example.test",),
    ("https://chat.example.test:99999",), ("https://chat.example.test:bad",),
    ("https://chat.example.test\n",),
])
def test_hosted_settings_reject_empty_wildcard_and_non_origin_values(origins):
    with pytest.raises(ValueError, match="ALLOWED_ORIGINS"):
        Settings(deployment_mode="hosted", allowed_origins=origins)


def test_hosted_settings_reject_lan_address(hosted_settings):
    with pytest.raises(ValueError, match="must not set LAN_ADVERTISE_IP"):
        replace(hosted_settings, lan_advertise_ip="192.168.1.42")


def test_invalid_deployment_mode_fails_closed(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_MODE", "cloud-typo")
    with pytest.raises(ValueError, match="DEPLOYMENT_MODE"):
        Settings.from_env()


def test_hosted_network_info_and_exact_origin_cors(hosted_settings):
    with TestClient(create_app(hosted_settings)) as client:
        response = client.get("/api/network", headers={"Origin": ORIGIN})
        assert response.json() == {
            "mode": "hosted", "advertised_host": None,
            "port": hosted_settings.app_port, "ready": True,
        }
        assert response.headers["access-control-allow-origin"] == ORIGIN
        refused = client.get("/api/network", headers={"Origin": "https://other.test"})
        assert "access-control-allow-origin" not in refused.headers


def test_hosted_websocket_rejects_lan_invitation_without_relay(hosted_settings, monkeypatch):
    relay = AsyncMock()
    monkeypatch.setattr("app.main.proxy_room_websocket", relay)
    with TestClient(create_app(hosted_settings)) as client:
        with client.websocket_connect(socket_url(room_id=LAN_ROOM), headers={"Origin": ORIGIN}) as socket:
            result = socket.receive_json()
            assert result["type"] == "error"
            assert result["code"] == "lan_relay_disabled"
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 4400
        assert client.app.state.repository.list_messages(LAN_ROOM, 10) == []
    relay.assert_not_called()


def test_hosted_attachments_reject_lan_without_reading_body_or_relay(hosted_settings, monkeypatch):
    relay = Mock()
    monkeypatch.setattr("app.attachments.relay_attachment", relay)
    body_reads = []

    def body():
        body_reads.append(True)
        yield b"not supposed to be read"

    path = f"/api/rooms/{LAN_ROOM}/attachments/{uuid4()}"
    with TestClient(create_app(hosted_settings)) as client:
        response = client.post(
            path, content=body(),
            headers={"Content-Type": "application/octet-stream", "Origin": ORIGIN},
        )
        assert response.status_code == 403
        assert response.json()["detail"] == "LAN invitations are disabled on this hosted server"
        assert client.get(path, headers={"Origin": ORIGIN}).status_code == 403
    assert body_reads == []
    relay.assert_not_called()


def test_hosted_standard_room_preserves_encrypted_exchange_and_media(hosted_settings):
    """Exercise hosted routing with existing envelopes; browser crypto has separate tests."""
    with TestClient(create_app(hosted_settings)) as client:
        with client.websocket_connect(socket_url(), headers={"Origin": ORIGIN}) as alice:
            receive_initial(alice)
            with client.websocket_connect(
                socket_url(client_id="bob", display_name="Bob"), headers={"Origin": ORIGIN},
            ) as bob:
                receive_initial(bob)
                assert alice.receive_json()["action"] == "joined"
                register_pair(alice, bob)
                alice.send_json(encrypted_message("demo"))
                assert alice.receive_json()["type"] == "message_ack"
                delivered = alice.receive_json()
                assert bob.receive_json() == delivered
                assert delivered["type"] == "encrypted_message"
                assert "text" not in delivered["message"]

                alice.send_json({"type": "message", "text": "reject downgrade", "client_message_id": "plain-1"})
                assert alice.receive_json()["code"] == "e2ee_required"

                path = f"/api/rooms/demo/attachments/{uuid4()}"
                ciphertext = b"opaque test ciphertext" * 3
                stored = client.post(path, content=ciphertext, headers={
                    "Content-Type": "application/octet-stream", "Origin": ORIGIN,
                })
                assert stored.status_code == 201
                assert client.get(path, headers={"Origin": ORIGIN}).content == ciphertext

        history = client.get("/api/rooms/demo/messages").json()
        assert history["e2ee_required"] is True
        assert history["messages"] == [delivered["message"]]


def test_hosted_websocket_still_rejects_untrusted_origin(hosted_settings):
    with TestClient(create_app(hosted_settings)) as client:
        with client.websocket_connect(socket_url(), headers={"Origin": "https://other.test"}) as socket:
            assert socket.receive_json()["code"] == "origin_not_allowed"
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 4403
