from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest

from app.relay import peer_websocket_url


def test_peer_websocket_url_encodes_identity_without_changing_target() -> None:
    url = peer_websocket_url(
        "192.168.1.42",
        8080,
        "QKD-0123456789ABCDEF-30AG09A",
        "client_1",
        "A & Bé",
    )
    parsed = urlsplit(url)
    assert parsed.scheme == "ws"
    assert parsed.hostname == "192.168.1.42"
    assert parsed.port == 8080
    assert parsed.path == "/ws/QKD-0123456789ABCDEF-30AG09A"
    assert parse_qs(parsed.query) == {
        "client_id": ["client_1"],
        "display_name": ["A & Bé"],
    }


@pytest.mark.parametrize(
    ("address", "port"),
    [("8.8.8.8", 8080), ("192.0.0.2", 8080), ("192.168.1.42", 0)],
)
def test_peer_websocket_url_rejects_unsafe_target(address: str, port: int) -> None:
    with pytest.raises(ValueError):
        peer_websocket_url(address, port, "demo", "alice", "Alice")

