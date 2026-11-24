"""Validated client commands and REST response models."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .bb84 import MAX_SAFE_INTEGER_SEED
from .e2ee import (
    E2EE_MESSAGE_ALGORITHM,
    E2EE_PUBLIC_KEY_ALGORITHM,
    E2EE_VERSION,
    decode_base64url,
    public_key_id,
    validate_ciphertext,
    validate_iv,
    validate_key_id,
    validate_p256_public_key,
)


CLIENT_MESSAGE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"


def _clean_text(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("text must not be empty")
    if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
        raise ValueError("text contains unsupported control characters")
    return value


class MessageCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["message"]
    text: str
    client_message_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=CLIENT_MESSAGE_ID_PATTERN,
    )

    _validate_text = field_validator("text")(_clean_text)


class TypingCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["typing"]
    is_typing: bool


class PingCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ping"]


class E2EEHelloCommand(BaseModel):
    """One browser's room/profile device-public-key advertisement."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["e2ee_hello"]
    version: Literal["e2ee-v1"]
    algorithm: Literal["ECDH-P256"]
    public_key_id: str
    public_key: str

    @model_validator(mode="after")
    def _validate_public_key_identity(self) -> "E2EEHelloCommand":
        if self.version != E2EE_VERSION or self.algorithm != E2EE_PUBLIC_KEY_ALGORITHM:
            raise ValueError("unsupported E2EE public-key protocol")
        validate_key_id(self.public_key_id, field_name="public_key_id")
        raw_key = validate_p256_public_key(self.public_key)
        if self.public_key_id != public_key_id(raw_key):
            raise ValueError("public_key_id does not match public_key")
        return self


class EncryptedMessageCommand(BaseModel):
    """Opaque AES-GCM envelope produced and consumed only by browsers."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["encrypted_message"]
    client_message_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=CLIENT_MESSAGE_ID_PATTERN,
    )
    version: Literal["e2ee-v1"]
    algorithm: Literal["AES-256-GCM"]
    key_id: str
    iv: str
    ciphertext: str

    @model_validator(mode="after")
    def _validate_envelope(self) -> "EncryptedMessageCommand":
        if self.version != E2EE_VERSION or self.algorithm != E2EE_MESSAGE_ALGORITHM:
            raise ValueError("unsupported encrypted-message protocol")
        validate_key_id(self.key_id)
        validate_iv(self.iv)
        validate_ciphertext(self.ciphertext)
        return self


class BB84ControlCommand(BaseModel):
    """Opaque endpoint-encrypted BB84 control packet; never persisted."""

    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["bb84_control"]
    version: Literal["bb84-endpoint-v1"]
    room_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    pair_key_id: str
    run_id: str = Field(min_length=22, max_length=22, pattern=r"^[A-Za-z0-9_-]{22}$")
    sender_key_id: str
    recipient_key_id: str
    sequence: int = Field(ge=0, le=65_535)
    nonce: str = Field(min_length=16, max_length=16, pattern=r"^[A-Za-z0-9_-]{16}$")
    ciphertext: str = Field(min_length=22, max_length=3_500, pattern=r"^[A-Za-z0-9_-]+$")

    @model_validator(mode="after")
    def _validate_opaque_control_envelope(self) -> "BB84ControlCommand":
        for name in ("pair_key_id", "sender_key_id", "recipient_key_id"):
            validate_key_id(getattr(self, name), field_name=name)
        if len(decode_base64url(self.run_id, field_name="run_id")) != 16:
            raise ValueError("run_id must decode to 16 bytes")
        if len(decode_base64url(self.nonce, field_name="nonce")) != 12:
            raise ValueError("nonce must decode to 12 bytes")
        if len(decode_base64url(self.ciphertext, field_name="ciphertext")) < 16:
            raise ValueError("ciphertext must include an AES-GCM tag")
        return self


class BB84StartCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["bb84_start"]
    qubit_count: Literal[128, 256, 512, 1024] = 512
    noise_probability: float = Field(default=0.0, ge=0.0, le=0.25)
    intercept_probability: float = Field(default=0.0, ge=0.0, le=1.0)
    sample_ratio: float = Field(default=0.25, ge=0.1, le=0.5)
    qber_threshold: float = Field(default=0.11, ge=0.01, le=0.25)
    seed: int | None = Field(
        default=None,
        ge=0,
        le=MAX_SAFE_INTEGER_SEED,
        strict=True,
    )

    @field_validator("qubit_count", mode="before")
    @classmethod
    def _require_integer_qubit_count(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("qubit_count must be an integer")
        return value

    @field_validator(
        "noise_probability",
        "intercept_probability",
        "sample_ratio",
        "qber_threshold",
        mode="before",
    )
    @classmethod
    def _require_numeric_probability(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("probability values must be JSON numbers")
        return value


class StoredMessage(BaseModel):
    id: str
    client_message_id: str
    sender_id: str
    sender_name: str
    text: str
    sent_at: str
    kind: Literal["message"] = "message"
    legacy_plaintext: Literal[True] | None = None


class StoredEncryptedMessage(BaseModel):
    id: str
    client_message_id: str
    sender_id: str
    sender_name: str
    sent_at: str
    kind: Literal["encrypted_message"] = "encrypted_message"
    version: Literal["e2ee-v1"]
    algorithm: Literal["AES-256-GCM"]
    key_id: str
    sender_key_id: str
    iv: str
    ciphertext: str


class Participant(BaseModel):
    client_id: str
    display_name: str


class HistoryResponse(BaseModel):
    room_id: str
    messages: list[StoredMessage | StoredEncryptedMessage]
    participants: list[Participant]
    e2ee_required: bool


class HealthResponse(BaseModel):
    status: Literal["ok"]
    database: Literal["ok"]
    service: Literal["secure-chat-starter"]


class NetworkInfoResponse(BaseModel):
    mode: Literal["localhost", "lan", "hosted"]
    advertised_host: str | None
    port: int = Field(ge=1, le=65_535)
    ready: bool
