"""Public Phase 4 E2EE envelope helpers.

The backend never performs ECDH or AES-GCM operations.  It validates and
relays browser-produced public keys and ciphertext envelopes, and derives a
public identifier for the currently advertised pair of browser keys.  These
identifiers are routing/integrity metadata, not identity authentication.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Sequence


E2EE_VERSION = "e2ee-v1"
E2EE_PUBLIC_KEY_ALGORITHM = "ECDH-P256"
E2EE_MESSAGE_ALGORITHM = "AES-256-GCM"
P256_UNCOMPRESSED_PUBLIC_KEY_BYTES = 65
AES_GCM_IV_BYTES = 12
AES_GCM_TAG_BYTES = 16
MAX_E2EE_PLAINTEXT_BYTES = 4_096
MAX_E2EE_CIPHERTEXT_BYTES = MAX_E2EE_PLAINTEXT_BYTES + AES_GCM_TAG_BYTES
SHA256_B64URL_LENGTH = 43

_B64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_PAIR_KEY_ID_LABEL = b"QKD-CHAT-E2EE-PAIR-KEY-ID-v1\x00"


def encode_base64url(value: bytes) -> str:
    """Return canonical unpadded base64url."""

    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode_base64url(value: str, *, field_name: str) -> bytes:
    """Decode canonical unpadded base64url or raise ``ValueError``."""

    if not value or not _B64URL_PATTERN.fullmatch(value):
        raise ValueError(f"{field_name} must be unpadded base64url")
    padding = "=" * (-len(value) % 4)
    try:
        decoded = base64.b64decode(
            value + padding,
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"{field_name} must be unpadded base64url") from exc
    if encode_base64url(decoded) != value:
        raise ValueError(f"{field_name} must use canonical unpadded base64url")
    return decoded


def validate_p256_public_key(value: str) -> bytes:
    """Apply the server's syntactic checks to a raw P-256 public key.

    A browser importing the key remains responsible for validating that the
    coordinates identify a point on P-256.  The relay intentionally does not
    become a cryptographic endpoint.
    """

    decoded = decode_base64url(value, field_name="public_key")
    if (
        len(decoded) != P256_UNCOMPRESSED_PUBLIC_KEY_BYTES
        or decoded[0] != 0x04
    ):
        raise ValueError(
            "public_key must be a 65-byte uncompressed P-256 public key"
        )
    return decoded


def public_key_id(public_key: bytes) -> str:
    """Identify one advertised public key by its SHA-256 digest."""

    if (
        len(public_key) != P256_UNCOMPRESSED_PUBLIC_KEY_BYTES
        or public_key[0] != 0x04
    ):
        raise ValueError("public_key must be an uncompressed P-256 public key")
    return encode_base64url(hashlib.sha256(public_key).digest())


def pair_key_id(room_id: str, public_keys: Sequence[bytes]) -> str:
    """Return the public ID expected for a room's current browser-key pair.

    The input is length-prefixed and both fixed-width public keys are sorted so
    Alice and Bob derive the same identifier regardless of connection order.
    The value authenticates neither key nor participant.
    """

    if len(public_keys) != 2:
        raise ValueError("exactly two public keys are required")
    encoded_room = room_id.encode("utf-8")
    if not encoded_room or len(encoded_room) > 65_535:
        raise ValueError("room_id is outside the supported length")
    checked = []
    for value in public_keys:
        if (
            len(value) != P256_UNCOMPRESSED_PUBLIC_KEY_BYTES
            or value[0] != 0x04
        ):
            raise ValueError("public keys must be uncompressed P-256 values")
        checked.append(value)
    left, right = sorted(checked)
    digest = hashlib.sha256(
        _PAIR_KEY_ID_LABEL
        + len(encoded_room).to_bytes(2, "big")
        + encoded_room
        + left
        + right
    ).digest()
    return encode_base64url(digest)


def validate_key_id(value: str, *, field_name: str = "key_id") -> str:
    """Validate a canonical SHA-256-sized public identifier."""

    if len(value) != SHA256_B64URL_LENGTH:
        raise ValueError(f"{field_name} must be a SHA-256 base64url identifier")
    decoded = decode_base64url(value, field_name=field_name)
    if len(decoded) != hashlib.sha256().digest_size:
        raise ValueError(f"{field_name} must be a SHA-256 base64url identifier")
    return value


def validate_iv(value: str) -> str:
    decoded = decode_base64url(value, field_name="iv")
    if len(decoded) != AES_GCM_IV_BYTES:
        raise ValueError("iv must decode to exactly 12 bytes")
    return value


def validate_ciphertext(value: str) -> str:
    decoded = decode_base64url(value, field_name="ciphertext")
    if not AES_GCM_TAG_BYTES + 1 <= len(decoded) <= MAX_E2EE_CIPHERTEXT_BYTES:
        raise ValueError(
            "ciphertext must encode 1 to "
            f"{MAX_E2EE_PLAINTEXT_BYTES} plaintext bytes plus a 16-byte GCM tag"
        )
    return value
