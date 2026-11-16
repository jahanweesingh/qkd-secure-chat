from __future__ import annotations

from ipaddress import IPv4Address

import pytest

from app.room_codes import (
    CROCKFORD_ALPHABET,
    InvalidInvitationRoomCode,
    decode_room_creator_ip,
)


def invitation_room_code(address: str, token: str = "0123456789ABCDEF") -> str:
    value = int(IPv4Address(address))
    encoded = ["0"] * 7
    for index in range(6, -1, -1):
        encoded[index] = CROCKFORD_ALPHABET[value % 32]
        value //= 32
    return f"QKD-{token}-{''.join(encoded)}"


@pytest.mark.parametrize(
    "address",
    [
        "10.0.0.1",
        "10.255.255.254",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.0.1",
        "192.168.255.254",
    ],
)
def test_invitation_room_code_decodes_rfc1918_creator(address: str) -> None:
    room_id = invitation_room_code(address)
    assert len(room_id) == 28
    assert decode_room_creator_ip(room_id) == address


def test_normal_room_ids_do_not_trigger_a_relay() -> None:
    assert decode_room_creator_ip("demo") is None
    assert decode_room_creator_ip("QKD-ABC123") is None
    assert decode_room_creator_ip("qkd-0123456789ABCDEF-0123456") is None
    assert decode_room_creator_ip("QKD-0123456789ABCDEI-0123456") is None


@pytest.mark.parametrize("address", ["192.0.0.2", "8.8.8.8", "127.0.0.1"])
def test_invitation_room_code_rejects_non_rfc1918_target(address: str) -> None:
    with pytest.raises(InvalidInvitationRoomCode):
        decode_room_creator_ip(invitation_room_code(address))


def test_invitation_room_code_rejects_value_larger_than_ipv4() -> None:
    with pytest.raises(InvalidInvitationRoomCode):
        decode_room_creator_ip("QKD-0123456789ABCDEF-ZZZZZZZ")

