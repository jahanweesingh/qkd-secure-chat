"""Decode LAN invitation room codes without accepting arbitrary relay targets."""

from __future__ import annotations

import re
from ipaddress import IPv4Address

from .config import RFC1918_NETWORKS

CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CROCKFORD_VALUES = {
    character: index for index, character in enumerate(CROCKFORD_ALPHABET)
}
INVITATION_ROOM_PATTERN = re.compile(
    rf"^QKD-[{CROCKFORD_ALPHABET}]{{16}}-[{CROCKFORD_ALPHABET}]{{7}}$"
)


class InvalidInvitationRoomCode(ValueError):
    """A shaped invitation code contains an unsafe or impossible target."""


def decode_room_creator_ip(room_id: str) -> str | None:
    """Return an RFC1918 creator IP, or ``None`` for a normal local room ID.

    The final seven characters are a fixed-width Crockford Base32 encoding of
    the unsigned, network-byte-order IPv4 integer. Only the strict uppercase
    alphabet is accepted. A syntactically valid invitation with a non-RFC1918
    target is rejected rather than silently becoming a local room.
    """

    if INVITATION_ROOM_PATTERN.fullmatch(room_id) is None:
        return None

    encoded_address = room_id.rsplit("-", 1)[1]
    value = 0
    for character in encoded_address:
        value = (value * 32) + CROCKFORD_VALUES[character]
    if value > 0xFFFFFFFF:
        raise InvalidInvitationRoomCode("encoded IPv4 value is out of range")

    address = IPv4Address(value)
    if not any(address in network for network in RFC1918_NETWORKS):
        raise InvalidInvitationRoomCode("encoded IPv4 address is not RFC1918")
    return str(address)
