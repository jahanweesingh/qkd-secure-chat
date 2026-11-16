"""Environment-backed application configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv4Network, ip_address, ip_network
from typing import Literal
from urllib.parse import urlsplit


RFC1918_NETWORKS: tuple[IPv4Network, ...] = (
    ip_network("10.0.0.0/8"),
    ip_network("172.16.0.0/12"),
    ip_network("192.168.0.0/16"),
)


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def _port(name: str, default: int) -> int:
    value = _positive_int(name, default)
    if value > 65_535:
        raise ValueError(f"{name} must be between 1 and 65535")
    return value


def normalize_rfc1918_ipv4(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    raw = value.strip()
    try:
        address = ip_address(raw)
    except ValueError as exc:
        raise ValueError(
            "LAN_ADVERTISE_IP must be an RFC1918 IPv4 address"
        ) from exc
    if not isinstance(address, IPv4Address) or not any(
        address in network for network in RFC1918_NETWORKS
    ):
        raise ValueError("LAN_ADVERTISE_IP must be an RFC1918 IPv4 address")
    return str(address)


@dataclass(frozen=True, slots=True)
class Settings:
    database_path: str = "./data/chat.db"
    allowed_origins: tuple[str, ...] | None = None
    default_history_limit: int = 50
    max_history_limit: int = 100
    max_message_length: int = 2_000
    max_websocket_event_bytes: int = 8_192
    lan_advertise_ip: str | None = None
    app_port: int = 8_080
    deployment_mode: Literal["local", "hosted"] = "local"

    def __post_init__(self) -> None:
        if self.deployment_mode not in {"local", "hosted"}:
            raise ValueError("DEPLOYMENT_MODE must be local or hosted")
        if self.allowed_origins is None:
            if self.deployment_mode == "hosted":
                raise ValueError("Hosted mode requires explicit ALLOWED_ORIGINS")
            object.__setattr__(self, "allowed_origins", (
                "http://localhost:3000", "http://localhost:5173",
            ))
        normalized_ip = normalize_rfc1918_ipv4(self.lan_advertise_ip)
        object.__setattr__(self, "lan_advertise_ip", normalized_ip)
        if self.deployment_mode == "hosted":
            if normalized_ip is not None:
                raise ValueError("Hosted mode must not set LAN_ADVERTISE_IP")
            if not self.allowed_origins:
                raise ValueError("Hosted mode requires explicit ALLOWED_ORIGINS")
            for origin in self.allowed_origins:
                try:
                    parsed = urlsplit(origin)
                    valid = (
                        parsed.scheme in {"http", "https"}
                        and bool(parsed.hostname)
                        and parsed.username is None
                        and parsed.password is None
                        and parsed.path == ""
                        and parsed.query == ""
                        and parsed.fragment == ""
                        and origin == f"{parsed.scheme}://{parsed.netloc}"
                        and "*" not in origin
                        and not any(character.isspace() for character in origin)
                        and (parsed.port is None or 1 <= parsed.port <= 65_535)
                    )
                except ValueError:
                    valid = False
                if not valid:
                    raise ValueError("Hosted ALLOWED_ORIGINS must contain exact HTTP(S) origins without wildcards or paths")
        if not isinstance(self.app_port, int) or isinstance(self.app_port, bool):
            raise ValueError("APP_PORT must be an integer")
        if not 1 <= self.app_port <= 65_535:
            raise ValueError("APP_PORT must be between 1 and 65535")

    @classmethod
    def from_env(cls) -> "Settings":
        history_limit = _positive_int("HISTORY_LIMIT", 100)
        deployment_mode = os.getenv("DEPLOYMENT_MODE", "local")
        origins = tuple(
            value.strip()
            for value in os.getenv(
                "ALLOWED_ORIGINS",
                "" if deployment_mode == "hosted" else "http://localhost:3000,http://localhost:5173",
            ).split(",")
            if value.strip()
        )
        return cls(
            database_path=os.getenv("DATABASE_PATH", "./data/chat.db"),
            allowed_origins=origins,
            default_history_limit=min(history_limit, 50),
            max_history_limit=history_limit,
            max_message_length=_positive_int("MAX_MESSAGE_LENGTH", 2_000),
            max_websocket_event_bytes=_positive_int(
                "MAX_WEBSOCKET_EVENT_BYTES", 8_192
            ),
            lan_advertise_ip=normalize_rfc1918_ipv4(os.getenv("LAN_ADVERTISE_IP")),
            app_port=_port("APP_PORT", 8_080),
            deployment_mode=deployment_mode,
        )
