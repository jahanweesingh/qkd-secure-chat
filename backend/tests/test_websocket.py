from __future__ import annotations

import asyncio
import json
from ipaddress import IPv4Address
from threading import Event

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.bb84 import simulate_bb84 as run_domain_simulation
from app.config import Settings
from app.main import create_app
from app.relay import MAX_RELAY_SERVER_FRAME_BYTES, RELAY_HEADER
from app.room_codes import CROCKFORD_ALPHABET

from .conftest import receive_initial, socket_url


def invitation_room_code(address: str) -> str:
    value = int(IPv4Address(address))
    encoded = ["0"] * 7
    for index in range(6, -1, -1):
        encoded[index] = CROCKFORD_ALPHABET[value % 32]
        value //= 32
    return f"QKD-0123456789ABCDEF-{''.join(encoded)}"


def relay_settings(settings: Settings, own_ip: str | None = None) -> Settings:
    return Settings(
        database_path=settings.database_path + "-relay",
        allowed_origins=settings.allowed_origins,
        default_history_limit=settings.default_history_limit,
        max_history_limit=settings.max_history_limit,
        max_message_length=settings.max_message_length,
        max_websocket_event_bytes=settings.max_websocket_event_bytes,
        lan_advertise_ip=own_ip,
        app_port=9_090,
    )


def test_two_user_message_typing_ping_presence_and_ack_contract(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url()) as alice:
        alice_connected, alice_joined = receive_initial(alice)
        assert alice_connected == {
            "type": "connected",
            "client_id": "alice",
            "room_id": "demo",
            "participants": [{"client_id": "alice", "display_name": "Alice"}],
            "messages": [],
            "e2ee_required": False,
            "e2ee_public_keys": [],
        }
        assert alice_joined["action"] == "joined"

        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            bob_connected, bob_joined = receive_initial(bob)
            alice_sees_bob = alice.receive_json()
            expected_participants = [
                {"client_id": "alice", "display_name": "Alice"},
                {"client_id": "bob", "display_name": "Bob"},
            ]
            assert bob_connected["participants"] == expected_participants
            assert bob_joined == alice_sees_bob
            assert bob_joined == {
                "type": "presence",
                "action": "joined",
                "client_id": "bob",
                "display_name": "Bob",
                "participants": expected_participants,
            }

            alice.send_json({"type": "typing", "is_typing": True})
            assert bob.receive_json() == {
                "type": "typing",
                "client_id": "alice",
                "display_name": "Alice",
                "is_typing": True,
            }

            alice.send_json(
                {
                    "type": "message",
                    "text": "Hello Bob",
                    "client_message_id": "alice-1",
                }
            )
            acknowledgement = alice.receive_json()
            alice_message = alice.receive_json()
            bob_message = bob.receive_json()
            assert acknowledgement == {
                "type": "message_ack",
                "client_message_id": "alice-1",
                "message_id": "1",
                "sent_at": acknowledgement["sent_at"],
                "duplicate": False,
            }
            assert alice_message == bob_message
            assert alice_message["type"] == "message"
            assert alice_message["message"] == {
                "id": "1",
                "client_message_id": "alice-1",
                "sender_id": "alice",
                "sender_name": "Alice",
                "text": "Hello Bob",
                "sent_at": acknowledgement["sent_at"],
                "kind": "message",
            }

            bob.send_json({"type": "ping"})
            assert bob.receive_json() == {"type": "pong"}

            bob.close()
            assert alice.receive_json() == {
                "type": "presence",
                "action": "left",
                "client_id": "bob",
                "display_name": "Bob",
                "participants": [{"client_id": "alice", "display_name": "Alice"}],
            }


def test_phase3_post_processing_is_identical_redacted_and_not_persisted(
    client: TestClient,
    monkeypatch,
) -> None:
    captured_simulations = []

    def observed_simulation(config):
        simulation = run_domain_simulation(config)
        captured_simulations.append(simulation)
        return simulation

    monkeypatch.setattr("app.main.simulate_bb84", observed_simulation)

    with client.websocket_connect(socket_url(room_id="phase3-room")) as alice:
        receive_initial(alice)
        with client.websocket_connect(
            socket_url(
                room_id="phase3-room",
                client_id="bob",
                display_name="Bob",
            )
        ) as bob:
            receive_initial(bob)
            assert alice.receive_json()["action"] == "joined"
            alice.send_json(
                {
                    "type": "bb84_start",
                    "qubit_count": 512,
                    "noise_probability": 0.0,
                    "intercept_probability": 0.0,
                    "sample_ratio": 0.25,
                    "qber_threshold": 0.11,
                    "seed": 7,
                }
            )
            alice_result = alice.receive_json()
            bob_result = bob.receive_json()

    assert alice_result == bob_result
    report = alice_result["post_processing"]
    assert report == {
        "version": "phase3-post-processing-v1",
        "status": "completed",
        "reason": "completed",
        "input_bits": alice_result["metrics"]["retained"],
        "reconciliation": {
            "algorithm": "cascade-inspired-parity-v1",
            "passes": 1,
            "corrected_errors": 0,
            "remaining_errors": 0,
            "leaked_bits": report["reconciliation"]["leaked_bits"],
            "verified": True,
        },
        "privacy_amplification": {
            "algorithm": "toeplitz-universal-hash-v1",
            "entropy_model": (
                "illustrative-asymptotic-bb84-binary-entropy-v1"
            ),
            "security_margin_bits": 32,
            "estimated_secret_bits": report["privacy_amplification"][
                "estimated_secret_bits"
            ],
            "output_bits": 128,
        },
        "confirmation": {
            "algorithm": "hmac-sha256-truncated-v1",
            "tag_bits": 128,
            "passed": True,
        },
        "derivation": {
            "algorithm": "hkdf-sha256-v1",
            "output_bits": 256,
            "context_bound": True,
            "material_retained": False,
        },
        "key_material_exposed": False,
        "key_used_for_chat": False,
        "reproducible_teaching_run": True,
    }
    assert alice_result["simulation_only"] is True
    assert alice_result["chat_encryption_active"] is False
    assert captured_simulations
    assert captured_simulations[0].private_candidate_material_retained is False
    assert client.app.state.repository.list_messages("phase3-room", 50) == []

    forbidden_keys = {
        "alice_bits",
        "bob_bits",
        "candidate_bits",
        "reconciled_bits",
        "seed_bits",
        "toeplitz_seed",
        "confirmation_tag",
        "derived_material",
        "derived_key",
    }

    def scan(value: object) -> None:
        if isinstance(value, dict):
            assert forbidden_keys.isdisjoint(value)
            for nested in value.values():
                scan(nested)
        elif isinstance(value, list):
            for nested in value:
                scan(nested)

    scan(alice_result)


def test_phase3_skips_post_processing_when_bb84_aborts(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url(room_id="phase3-abort")) as socket:
        receive_initial(socket)
        socket.send_json(
            {
                "type": "bb84_start",
                "qubit_count": 1024,
                "noise_probability": 0.25,
                "sample_ratio": 0.5,
                "qber_threshold": 0.10,
                "seed": 31,
            }
        )
        result = socket.receive_json()

    assert result["decision"]["status"] == "aborted"
    report = result["post_processing"]
    assert report["status"] == "skipped"
    assert report["reason"] == "bb84_not_accepted"
    assert report["input_bits"] == result["metrics"]["retained"]
    assert report["reconciliation"]["passes"] == 0
    assert report["privacy_amplification"]["output_bits"] == 0
    assert report["confirmation"]["passed"] is False
    assert report["derivation"]["material_retained"] is False


def test_phase3_reports_insufficient_entropy_separately(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url(room_id="phase3-short")) as socket:
        receive_initial(socket)
        socket.send_json(
            {
                "type": "bb84_start",
                "qubit_count": 128,
                "noise_probability": 0.0,
                "intercept_probability": 0.0,
                "sample_ratio": 0.25,
                "qber_threshold": 0.11,
                "seed": 7,
            }
        )
        result = socket.receive_json()

    assert result["decision"]["status"] == "accepted"
    report = result["post_processing"]
    assert report["status"] == "failed"
    assert report["reason"] == "insufficient_entropy"
    assert report["reconciliation"]["verified"] is True
    assert report["privacy_amplification"]["estimated_secret_bits"] < 128
    assert report["privacy_amplification"]["output_bits"] == 0
    assert report["derivation"]["output_bits"] == 0


def test_phase3_broadcasts_injected_confirmation_failure_and_keeps_room_alive(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.postprocessing.confirmation_passes",
        lambda *args, **kwargs: False,
    )

    with client.websocket_connect(socket_url(room_id="phase3-confirmation-fault")) as socket:
        receive_initial(socket)
        socket.send_json(
            {
                "type": "bb84_start",
                "qubit_count": 512,
                "noise_probability": 0.0,
                "intercept_probability": 0.0,
                "sample_ratio": 0.25,
                "qber_threshold": 0.11,
                "seed": 7,
            }
        )
        result = socket.receive_json()
        report = result["post_processing"]
        assert report["status"] == "failed"
        assert report["reason"] == "confirmation_failed"
        assert report["reconciliation"]["verified"] is True
        assert report["privacy_amplification"]["output_bits"] == 128
        assert report["confirmation"]["passed"] is False
        assert report["derivation"] == {
            "algorithm": "hkdf-sha256-v1",
            "output_bits": 0,
            "context_bound": False,
            "material_retained": False,
        }
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}


def test_phase3_reports_injected_derivation_failure_without_rewriting_confirmation(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outputs = iter((bytearray([0] * 32), bytearray([1] * 32)))

    def mismatched_derivation(*args: object, **kwargs: object) -> bytearray:
        return next(outputs)

    monkeypatch.setattr(
        "app.postprocessing._derive_context_material",
        mismatched_derivation,
    )

    with client.websocket_connect(socket_url(room_id="phase3-derivation-fault")) as socket:
        receive_initial(socket)
        socket.send_json(
            {
                "type": "bb84_start",
                "qubit_count": 512,
                "noise_probability": 0.0,
                "intercept_probability": 0.0,
                "sample_ratio": 0.25,
                "qber_threshold": 0.11,
                "seed": 7,
            }
        )
        report = socket.receive_json()["post_processing"]
        assert report["status"] == "failed"
        assert report["reason"] == "derivation_failed"
        assert report["reconciliation"]["verified"] is True
        assert report["privacy_amplification"]["output_bits"] == 128
        assert report["confirmation"]["passed"] is True
        assert report["derivation"] == {
            "algorithm": "hkdf-sha256-v1",
            "output_bits": 0,
            "context_bound": False,
            "material_retained": False,
        }
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}


def test_duplicate_client_message_is_idempotent(client: TestClient) -> None:
    event = {
        "type": "message",
        "text": "Only once",
        "client_message_id": "retry-1",
    }
    with client.websocket_connect(socket_url()) as socket:
        receive_initial(socket)
        socket.send_json(event)
        first_ack = socket.receive_json()
        assert socket.receive_json()["type"] == "message"
        socket.send_json(event)
        duplicate_ack = socket.receive_json()

    assert first_ack["type"] == duplicate_ack["type"] == "message_ack"
    assert first_ack["message_id"] == duplicate_ack["message_id"] == "1"
    assert first_ack["duplicate"] is False
    assert duplicate_ack["duplicate"] is True
    history = client.get("/api/rooms/demo/messages").json()
    assert len(history["messages"]) == 1


def test_room_rejects_third_distinct_client(client: TestClient) -> None:
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            receive_initial(bob)
            assert alice.receive_json()["action"] == "joined"
            with client.websocket_connect(
                socket_url(client_id="charlie", display_name="Charlie")
            ) as charlie:
                assert charlie.receive_json() == {
                    "type": "error",
                    "code": "room_full",
                    "message": "This room already has two distinct clients",
                }
                with pytest.raises(WebSocketDisconnect) as closed:
                    charlie.receive_json()
                assert closed.value.code == 4403


def test_room_rejects_duplicate_active_client_id(client: TestClient) -> None:
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        with client.websocket_connect(socket_url(display_name="Other Alice")) as duplicate:
            assert duplicate.receive_json()["code"] == "client_already_connected"
            with pytest.raises(WebSocketDisconnect) as closed:
                duplicate.receive_json()
            assert closed.value.code == 4409


def test_websocket_origin_policy(client: TestClient, settings: Settings) -> None:
    with client.websocket_connect(
        socket_url(), headers={"origin": "http://localhost:5173"}
    ) as allowed:
        receive_initial(allowed)

    with client.websocket_connect(
        socket_url(), headers={"origin": "https://untrusted.example"}
    ) as rejected:
        assert rejected.receive_json() == {
            "type": "error",
            "code": "origin_not_allowed",
            "message": "The WebSocket Origin is not allowed",
        }
        with pytest.raises(WebSocketDisconnect) as closed:
            rejected.receive_json()
        assert closed.value.code == 4403

    wildcard_settings = Settings(
        database_path=settings.database_path + "-wildcard",
        allowed_origins=("*",),
    )
    with TestClient(create_app(wildcard_settings)) as wildcard_client:
        with wildcard_client.websocket_connect(
            socket_url(), headers={"origin": "https://any.example"}
        ) as allowed_by_wildcard:
            receive_initial(allowed_by_wildcard)


def test_websocket_allows_exact_https_cloudflare_tunnel_origin(
    settings: Settings,
) -> None:
    tunnel_origin = "https://bb84-demo.trycloudflare.com"
    tunnel_settings = Settings(
        database_path=settings.database_path + "-cloudflare-ws",
        allowed_origins=("http://localhost:5173", tunnel_origin),
        default_history_limit=settings.default_history_limit,
        max_history_limit=settings.max_history_limit,
        max_message_length=settings.max_message_length,
        max_websocket_event_bytes=settings.max_websocket_event_bytes,
        app_port=settings.app_port,
    )
    with TestClient(create_app(tunnel_settings)) as tunnel_client:
        with tunnel_client.websocket_connect(
            socket_url(), headers={"origin": tunnel_origin}
        ) as allowed:
            receive_initial(allowed)

        with tunnel_client.websocket_connect(
            socket_url(), headers={"origin": "https://other.trycloudflare.com"}
        ) as rejected:
            assert rejected.receive_json() == {
                "type": "error",
                "code": "origin_not_allowed",
                "message": "The WebSocket Origin is not allowed",
            }
            with pytest.raises(WebSocketDisconnect) as closed:
                rejected.receive_json()
            assert closed.value.code == 4403


def test_invalid_identity_returns_structured_error(client: TestClient) -> None:
    with client.websocket_connect(socket_url(room_id="bad.room")) as socket:
        error = socket.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "invalid_identity"
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()
        assert closed.value.code == 4400


def test_invalid_events_are_recoverable_and_bounded(client: TestClient) -> None:
    with client.websocket_connect(socket_url()) as socket:
        receive_initial(socket)

        socket.send_text("{")
        assert socket.receive_json()["code"] == "invalid_json"

        socket.send_json(["not", "an", "object"])
        assert socket.receive_json()["code"] == "invalid_event"

        socket.send_bytes(b"binary")
        assert socket.receive_json()["code"] == "text_frames_only"

        socket.send_json({"type": "unknown"})
        assert socket.receive_json()["code"] == "unsupported_event"

        socket.send_json({"type": []})
        assert socket.receive_json()["code"] == "unsupported_event"
        socket.send_json({"type": {}})
        assert socket.receive_json()["code"] == "unsupported_event"

        socket.send_json({"type": "ping", "unexpected": True})
        assert socket.receive_json()["code"] == "validation_error"

        socket.send_json(
            {
                "type": "message",
                "text": "x" * 21,
                "client_message_id": "too-long",
            }
        )
        too_long = socket.receive_json()
        assert too_long["code"] == "message_too_long"
        assert too_long["client_message_id"] == "too-long"

        socket.send_json(
            {
                "type": "message",
                "text": "   ",
                "client_message_id": "empty-message",
            }
        )
        empty = socket.receive_json()
        assert empty["code"] == "validation_error"
        assert empty["client_message_id"] == "empty-message"

        socket.send_text("x" * 257)
        assert socket.receive_json()["code"] == "event_too_large"

        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}

        socket.send_json({"type": "bb84_start", "unknown_setting": True})
        assert socket.receive_json() == {
            "type": "error",
            "code": "validation_error",
            "message": "Event payload is invalid",
        }
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}


def test_invitation_for_this_instance_uses_normal_local_room_flow(
    settings: Settings, monkeypatch
) -> None:
    def unexpected_connect(*args, **kwargs):
        raise AssertionError("a creator instance must not relay to itself")

    monkeypatch.setattr("app.relay.connect", unexpected_connect)
    own_ip = "192.168.42.17"
    with TestClient(create_app(relay_settings(settings, own_ip))) as creator:
        with creator.websocket_connect(
            socket_url(room_id=invitation_room_code(own_ip))
        ) as socket:
            connected, _ = receive_initial(socket)
            assert connected["client_id"] == "alice"


def test_remote_invitation_relays_frames_with_bounds(
    settings: Settings, monkeypatch
) -> None:
    captured: dict[str, object] = {}

    class FakePeer:
        def __init__(self) -> None:
            self.incoming: asyncio.Queue[str] = asyncio.Queue()
            self.sent: list[str | bytes] = []

        async def send(self, frame: str | bytes) -> None:
            self.sent.append(frame)
            if isinstance(frame, str):
                event_type = json.loads(frame).get("type")
                if event_type == "ping":
                    await self.incoming.put('{"type":"pong"}')
                elif event_type == "relay_history_probe":
                    await self.incoming.put(
                        json.dumps(
                            {
                                "type": "connected",
                                "messages": [
                                    {"ciphertext": "x" * 7_000},
                                    {"ciphertext": "y" * 7_000},
                                ],
                            }
                        )
                    )
                elif event_type == "relay_oversize_probe":
                    await self.incoming.put(
                        json.dumps(
                            {
                                "type": "connected",
                                "blob": "z" * MAX_RELAY_SERVER_FRAME_BYTES,
                            }
                        )
                    )

        def __aiter__(self):
            return self

        async def __anext__(self) -> str:
            return await self.incoming.get()

    class FakeConnection:
        async def __aenter__(self) -> FakePeer:
            peer = FakePeer()
            captured["peer"] = peer
            return peer

        async def __aexit__(self, exc_type, exc, traceback) -> None:
            return None

    def fake_connect(url: str, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return FakeConnection()

    monkeypatch.setattr("app.relay.connect", fake_connect)
    remote_ip = "192.168.42.18"
    configured = relay_settings(settings, "192.168.42.17")
    with TestClient(create_app(configured)) as guest:
        with guest.websocket_connect(
            socket_url(room_id=invitation_room_code(remote_ip))
        ) as socket:
            socket.send_text("x" * (configured.max_websocket_event_bytes + 1))
            assert socket.receive_json()["code"] == "event_too_large"
            socket.send_json({"type": "ping"})
            assert socket.receive_json() == {"type": "pong"}
            socket.send_json({"type": "relay_history_probe"})
            large_history = socket.receive_json()
            assert large_history["type"] == "connected"
            assert len(json.dumps(large_history).encode("utf-8")) > 8_192
            socket.send_json({"type": "relay_oversize_probe"})
            assert socket.receive_json() == {
                "type": "error",
                "code": "event_too_large",
                "message": "Peer WebSocket event is too large",
            }

    assert captured["url"] == (
        f"ws://{remote_ip}:9090/ws/{invitation_room_code(remote_ip)}"
        "?client_id=alice&display_name=Alice"
    )
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["open_timeout"] == 3.0
    assert kwargs["max_size"] == MAX_RELAY_SERVER_FRAME_BYTES
    assert kwargs["proxy"] is None
    assert kwargs["additional_headers"] == {RELAY_HEADER: "1"}
    peer = captured["peer"]
    assert isinstance(peer, FakePeer)
    assert len(peer.sent) == 3
    assert json.loads(peer.sent[0]) == {"type": "ping"}
    assert json.loads(peer.sent[1]) == {"type": "relay_history_probe"}
    assert json.loads(peer.sent[2]) == {"type": "relay_oversize_probe"}


def test_unreachable_invitation_peer_returns_structured_error(
    settings: Settings, monkeypatch
) -> None:
    class FailingConnection:
        async def __aenter__(self):
            raise OSError("unreachable")

        async def __aexit__(self, exc_type, exc, traceback) -> None:
            return None

    monkeypatch.setattr("app.relay.connect", lambda *args, **kwargs: FailingConnection())
    with TestClient(create_app(relay_settings(settings))) as guest:
        with guest.websocket_connect(
            socket_url(room_id=invitation_room_code("192.168.42.18"))
        ) as socket:
            assert socket.receive_json() == {
                "type": "error",
                "code": "peer_unreachable",
                "message": "The room host could not be reached on the local network",
            }
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 4410


def test_relay_header_prevents_forwarding_loop(settings: Settings, monkeypatch) -> None:
    def unexpected_connect(*args, **kwargs):
        raise AssertionError("a relayed connection must not be relayed again")

    monkeypatch.setattr("app.relay.connect", unexpected_connect)
    with TestClient(create_app(relay_settings(settings))) as guest:
        with guest.websocket_connect(
            socket_url(room_id=invitation_room_code("192.168.42.18")),
            headers={RELAY_HEADER: "1"},
        ) as socket:
            assert socket.receive_json()["code"] == "peer_unreachable"
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 4410


def test_invitation_with_unsafe_target_is_rejected(settings: Settings) -> None:
    with TestClient(create_app(relay_settings(settings))) as guest:
        with guest.websocket_connect(
            socket_url(room_id=invitation_room_code("192.0.0.2"))
        ) as socket:
            assert socket.receive_json() == {
                "type": "error",
                "code": "invalid_room_code",
                "message": (
                    "The invitation room code does not contain a valid private host address"
                ),
            }
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 4400


def test_bb84_simulation_is_broadcast_and_does_not_change_plaintext_chat(
    client: TestClient,
) -> None:
    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            receive_initial(bob)
            assert alice.receive_json()["action"] == "joined"

            command = {
                "type": "bb84_start",
                "qubit_count": 128,
                "noise_probability": 0.02,
                "intercept_probability": 0.25,
                "sample_ratio": 0.25,
                "qber_threshold": 0.11,
                "seed": 4242,
            }
            alice.send_json(command)
            alice_result = alice.receive_json()
            bob_result = bob.receive_json()
            assert alice_result == bob_result
            assert alice_result["type"] == "bb84_result"
            assert alice_result["session_id"].startswith("sim_")
            assert alice_result["started_by"] == "alice"
            assert alice_result["simulation_only"] is True
            assert alice_result["chat_encryption_active"] is False
            assert alice_result["config"] == {
                key: value for key, value in command.items() if key != "type"
            }
            assert alice_result["metrics"]["transmitted"] == 128
            assert alice_result["metrics"]["retained"] == (
                alice_result["metrics"]["sifted"]
                - alice_result["metrics"]["sample"]
            )
            assert alice_result["decision"]["status"] in {"accepted", "aborted"}
            assert len(alice_result["trace"]) <= 24
            for row in alice_result["trace"]:
                assert "alice_bit" not in row
                assert "bob_bit" not in row
                if not row["sampled"]:
                    assert row["sample_comparison"] is None

            alice.send_json(
                {
                    "type": "message",
                    "text": "Chat stays plaintext",
                    "client_message_id": "after-simulation",
                }
            )
            assert alice.receive_json()["type"] == "message_ack"
            assert alice.receive_json()["type"] == "message"
            delivered = bob.receive_json()
            assert delivered["type"] == "message"
            assert delivered["message"]["text"] == "Chat stays plaintext"


def test_invalid_bb84_command_is_recoverable(client: TestClient) -> None:
    with client.websocket_connect(socket_url()) as socket:
        receive_initial(socket)
        socket.send_json(
            {
                "type": "bb84_start",
                "qubit_count": 129,
                "noise_probability": 0.5,
            }
        )
        assert socket.receive_json() == {
            "type": "error",
            "code": "validation_error",
            "message": "Event payload is invalid",
        }
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}


def test_simultaneous_bb84_start_is_rejected_recoverably(
    client: TestClient,
    monkeypatch,
) -> None:
    simulation_started = Event()
    release_simulation = Event()

    def delayed_simulation(config):
        simulation_started.set()
        assert release_simulation.wait(timeout=3)
        return run_domain_simulation(config)

    monkeypatch.setattr("app.main.simulate_bb84", delayed_simulation)

    with client.websocket_connect(socket_url()) as alice:
        receive_initial(alice)
        with client.websocket_connect(
            socket_url(client_id="bob", display_name="Bob")
        ) as bob:
            receive_initial(bob)
            assert alice.receive_json()["action"] == "joined"

            alice.send_json({"type": "bb84_start", "qubit_count": 128, "seed": 1})
            assert simulation_started.wait(timeout=3)

            bob.send_json({"type": "bb84_start", "qubit_count": 128, "seed": 2})
            assert bob.receive_json() == {
                "type": "error",
                "code": "bb84_busy",
                "message": "A BB84 simulation is already running for this room",
            }

            release_simulation.set()
            alice_result = alice.receive_json()
            bob_result = bob.receive_json()
            assert alice_result == bob_result
            assert alice_result["type"] == "bb84_result"
            assert alice_result["started_by"] == "alice"

            bob.send_json({"type": "ping"})
            assert bob.receive_json() == {"type": "pong"}
