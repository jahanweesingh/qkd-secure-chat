from dataclasses import replace
import secrets
import sqlite3
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app import attachments
from app.main import create_app


def path(room="media-room", attachment_id=None):
    return f"/api/rooms/{room}/attachments/{attachment_id or uuid4()}"


def activate(client, room="media-room"):
    client.app.state.repository.require_e2ee(room, "2026-11-12T00:00:00Z")


def upload(client, url, body=b"opaque ciphertext" + b"x" * 40, **kwargs):
    return client.post(url, content=body, headers={"Content-Type": "application/octet-stream", **kwargs})


def test_attachment_roundtrip_is_opaque_immutable_and_persistent(client, settings):
    activate(client)
    url = path()
    ciphertext = secrets.token_bytes(256)
    response = upload(client, url, ciphertext)
    assert response.status_code == 201
    assert set(response.json()) == {"attachment_id", "ciphertext_bytes"}
    assert response.json()["ciphertext_bytes"] == 256
    assert upload(client, url, ciphertext).status_code == 200
    assert upload(client, url, b"other content" * 20).status_code == 409
    received = client.get(url)
    assert received.content == ciphertext
    assert received.headers["content-type"] == "application/octet-stream"
    assert received.headers["cache-control"] == "no-store"
    assert received.headers["x-content-type-options"] == "nosniff"
    assert received.headers["content-disposition"] == "attachment"
    assert client.get(url.replace("media-room", "other-room")).status_code == 404
    with TestClient(create_app(settings)) as reopened:
        assert reopened.get(url).content == ciphertext
    with sqlite3.connect(settings.database_path) as connection:
        row = connection.execute("SELECT ciphertext, ciphertext_bytes FROM encrypted_attachments").fetchone()
        assert row == (ciphertext, 256)
        columns = {r[1] for r in connection.execute("PRAGMA table_info(encrypted_attachments)")}
        assert not columns.intersection({"name", "filename", "mime", "key", "iv", "plaintext"})
    assert client.get("/api/rooms/media-room/messages").json()["messages"] == []


def test_attachment_requires_existing_encrypted_room(client):
    assert upload(client, path()).status_code == 409
    assert upload(client, path(), **{"Origin": "https://unexpected.example"}).status_code == 403


@pytest.mark.parametrize("attachment_id", ["foo", "../other", "not-a-uuid", "00000000-0000-0000-0000-000000000000"])
def test_attachment_identifiers_are_strict(client, attachment_id):
    assert upload(client, path(attachment_id=attachment_id)).status_code in (404, 422)


@pytest.mark.parametrize("body", [b"", b"tiny", b"x" * 16])
def test_attachment_rejects_empty_or_short_ciphertext(client, body):
    activate(client)
    assert upload(client, path(), body).status_code == 413


def test_attachment_rejects_content_types_and_oversize_before_storage(client):
    activate(client)
    url = path()
    assert client.post(url, json={"key": "never accepted"}).status_code == 415
    assert upload(client, url, **{"Content-Length": str(attachments.MAX_CIPHERTEXT_BYTES + 1)}).status_code == 413
    response = client.post(url, content=iter([b"x" * 6_000_000, b"x" * 5_000_000]), headers={"Content-Type": "application/octet-stream"})
    assert response.status_code == 413
    assert client.get(url).status_code == 404


def test_attachment_accepts_exact_maximum_size(client):
    activate(client)
    url = path()
    body = b"x" * attachments.MAX_CIPHERTEXT_BYTES
    assert upload(client, url, body).status_code == 201
    assert client.get(url).content == body


def test_room_attachment_count_quota_does_not_evict_previous_files(client, monkeypatch):
    monkeypatch.setattr(attachments, "MAX_ROOM_ATTACHMENTS", 2)
    activate(client)
    urls = [path() for _ in range(3)]
    assert upload(client, urls[0]).status_code == 201
    assert upload(client, urls[1]).status_code == 201
    assert upload(client, urls[2]).status_code == 413
    assert client.get(urls[0]).status_code == 200
    assert upload(client, urls[0]).status_code == 200


def test_room_attachment_byte_quota(client, monkeypatch):
    monkeypatch.setattr(attachments, "MAX_ROOM_BYTES", 100)
    activate(client)
    assert upload(client, path(), b"x" * 60).status_code == 201
    assert upload(client, path(), b"y" * 50).status_code == 413


def test_global_attachment_quota_cannot_be_bypassed_by_new_rooms(client, monkeypatch):
    monkeypatch.setattr(attachments, "MAX_STORE_BYTES", 100)
    activate(client)
    activate(client, "other-room")
    assert upload(client, path(), b"x" * 60).status_code == 201
    assert upload(client, path(room="other-room"), b"y" * 50).status_code == 413


def test_attachment_post_cors_preflight(client):
    response = client.options(path(), headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_lan_attachment_uses_only_decoded_room_target_and_rejects_loops(settings, monkeypatch):
    calls = []
    ciphertext = b"opaque encrypted content" * 3
    def relay(ip, port, room, attachment_id, method, body):
        calls.append((ip, port, room, method, body))
        return (201, b"") if method == "POST" else (200, ciphertext)
    monkeypatch.setattr(attachments, "relay_attachment", relay)
    room = "QKD-0123456789ABCDEF-30AG09A"
    url = path(room=room)
    with TestClient(create_app(replace(settings, lan_advertise_ip="192.168.1.43"))) as guest:
        assert upload(guest, url, ciphertext).status_code == 201
        assert guest.get(url).content == ciphertext
        assert upload(guest, url, ciphertext, **{attachments.RELAY_HEADER: "1"}).status_code == 502
        assert guest.get(url, headers={attachments.RELAY_HEADER: "1"}).status_code == 502
        assert len(calls) == 2
        assert calls[0] == ("192.168.1.42", settings.app_port, room, "POST", ciphertext)
        assert calls[1] == ("192.168.1.42", settings.app_port, room, "GET", None)


class FakeResponse:
    status = 200
    content_type = "application/octet-stream"
    requested_bytes = None
    def getheader(self, name, default):
        return self.content_type
    def read(self, count):
        self.requested_bytes = count
        return b"ciphertext" * 3


class FakeConnection:
    response = FakeResponse()
    request_args = None
    closed = False
    def __init__(self, host, port, timeout):
        self.target = (host, port, timeout)
    def request(self, method, path, body, headers):
        type(self).request_args = (method, path, body, headers)
    def getresponse(self):
        return self.response
    def close(self):
        type(self).closed = True


def test_http_attachment_relay_caps_response_and_forbids_redirects(monkeypatch):
    monkeypatch.setattr(attachments.http.client, "HTTPConnection", FakeConnection)
    response = FakeResponse()
    monkeypatch.setattr(FakeConnection, "response", response)
    result = attachments.relay_attachment("192.168.1.42", 8080, "room", str(uuid4()), "GET", None)
    assert result == (200, b"ciphertext" * 3)
    assert response.requested_bytes == attachments.MAX_CIPHERTEXT_BYTES + 1
    assert FakeConnection.request_args[3][attachments.RELAY_HEADER] == "1"
    assert FakeConnection.closed
    response.status = 302
    with pytest.raises(attachments.HTTPException) as exc:
        attachments.relay_attachment("192.168.1.42", 8080, "room", str(uuid4()), "GET", None)
    assert exc.value.status_code == 502


def test_http_attachment_relay_rejects_non_private_target_and_wrong_content_type(monkeypatch):
    with pytest.raises(attachments.HTTPException):
        attachments.relay_attachment("8.8.8.8", 8080, "room", str(uuid4()), "GET", None)
    monkeypatch.setattr(attachments.http.client, "HTTPConnection", FakeConnection)
    response = FakeResponse()
    response.content_type = "text/html"
    monkeypatch.setattr(FakeConnection, "response", response)
    with pytest.raises(attachments.HTTPException) as exc:
        attachments.relay_attachment("192.168.1.42", 8080, "room", str(uuid4()), "GET", None)
    assert exc.value.status_code == 502


def test_attachment_quota_is_atomic_for_concurrent_writers(client, settings, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    activate(client)
    monkeypatch.setattr(attachments, "MAX_ROOM_ATTACHMENTS", 1)
    store = attachments.AttachmentStore(settings.database_path)
    start = Barrier(2)
    def write():
        start.wait(timeout=2)
        try:
            store.put("media-room", str(uuid4()), b"opaque" * 8)
            return 201
        except attachments.HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: write(), range(2)))
    assert sorted(results) == [201, 413]
