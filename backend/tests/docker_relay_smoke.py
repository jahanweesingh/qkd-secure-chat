"""Two-container relay smoke check; run explicitly, not as a pytest module."""

from __future__ import annotations

import asyncio
import json
import os
from ipaddress import IPv4Address
from urllib.request import Request, ProxyHandler, build_opener
from uuid import uuid4

from websockets.asyncio.client import connect

from app.e2ee import encode_base64url, pair_key_id, public_key_id
from app.room_codes import CROCKFORD_ALPHABET


FORBIDDEN_SECRET_KEYS = {
    "alice_bits",
    "bob_bits",
    "candidate_bits",
    "corrected_bits",
    "derived_key",
    "derived_material",
    "final_key",
    "key_bytes",
    "private_bits",
    "raw_key",
    "secret_key",
    "shared_key",
    "sifted_bits",
    "toeplitz_seed",
}


def assert_secret_free(value: object, path: str = "result") -> None:
    """Fail if a serialized result contains a known secret-bearing field."""

    if isinstance(value, dict):
        for key, child in value.items():
            normalized = key.lower().replace("-", "_")
            assert normalized not in FORBIDDEN_SECRET_KEYS, f"secret field at {path}.{key}"
            assert_secret_free(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_secret_free(child, f"{path}[{index}]")


def invitation_room_code(address: str) -> str:
    value = int(IPv4Address(address))
    encoded = ["0"] * 7
    for index in range(6, -1, -1):
        encoded[index] = CROCKFORD_ALPHABET[value % 32]
        value //= 32
    return f"QKD-0123456789ABCDEF-{''.join(encoded)}"


def raw_public_key(marker: int) -> bytes:
    return b"\x04" + bytes([marker]) * 64


def hello(marker: int) -> dict[str, str]:
    raw = raw_public_key(marker)
    return {
        "type": "e2ee_hello",
        "version": "e2ee-v1",
        "algorithm": "ECDH-P256",
        "public_key_id": public_key_id(raw),
        "public_key": encode_base64url(raw),
    }


async def receive_json(socket) -> dict[str, object]:
    frame = await asyncio.wait_for(socket.recv(), timeout=5)
    assert isinstance(frame, str)
    value = json.loads(frame)
    assert isinstance(value, dict)
    return value


async def main() -> None:
    creator_host = os.getenv("CREATOR_HOST", "172.29.240.10")
    guest_host = os.getenv("GUEST_HOST", "172.29.240.11")
    port = int(os.getenv("PEER_PORT", "8000"))
    room_id = invitation_room_code(creator_host)
    alice_url = (
        f"ws://{creator_host}:{port}/ws/{room_id}"
        "?client_id=alice&display_name=Alice"
    )
    bob_url = (
        f"ws://{guest_host}:{port}/ws/{room_id}"
        "?client_id=bob&display_name=Bob"
    )

    async with connect(alice_url, proxy=None) as alice:
        assert (await receive_json(alice))["type"] == "connected"
        assert (await receive_json(alice))["type"] == "presence"
        async with connect(bob_url, proxy=None) as bob:
            bob_connected = await receive_json(bob)
            assert bob_connected["type"] == "connected"
            assert len(bob_connected["participants"]) == 2
            assert (await receive_json(bob))["type"] == "presence"
            alice_presence = await receive_json(alice)
            assert alice_presence["type"] == "presence"
            assert alice_presence["action"] == "joined"

            await alice.send(
                json.dumps(
                    {
                        "type": "message",
                        "text": "creator to guest",
                        "client_message_id": "creator-1",
                    }
                )
            )
            assert (await receive_json(alice))["type"] == "message_ack"
            alice_message = await receive_json(alice)
            bob_message = await receive_json(bob)
            assert alice_message == bob_message
            assert bob_message["message"]["text"] == "creator to guest"

            await bob.send(
                json.dumps(
                    {
                        "type": "message",
                        "text": "guest to creator",
                        "client_message_id": "guest-1",
                    }
                )
            )
            assert (await receive_json(bob))["type"] == "message_ack"
            bob_message = await receive_json(bob)
            alice_message = await receive_json(alice)
            assert alice_message == bob_message
            assert alice_message["message"]["text"] == "guest to creator"

            await alice.send(json.dumps(hello(1)))
            alice_public_key = await receive_json(alice)
            bob_public_key = await receive_json(bob)
            assert alice_public_key == bob_public_key
            assert alice_public_key["type"] == "e2ee_public_key"

            await bob.send(json.dumps(hello(2)))
            alice_public_key = await receive_json(alice)
            bob_public_key = await receive_json(bob)
            assert alice_public_key == bob_public_key
            assert bob_public_key["client_id"] == "bob"

            # Attachment HTTP takes the same validated, single-hop LAN route.
            # Opaque test bytes exercise transport/storage, not browser crypto.
            def transfer_attachment(source, destination, marker):
                attachment_id = str(uuid4())
                suffix = f"/api/rooms/{room_id}/attachments/{attachment_id}"
                ciphertext = marker * (2 * 1024 * 1024 + 16)
                opener = build_opener(ProxyHandler({}))
                request = Request(
                    f"http://{source}:{port}{suffix}", data=ciphertext,
                    headers={"Content-Type": "application/octet-stream"}, method="POST",
                )
                with opener.open(request, timeout=20) as response:
                    assert response.status == 201
                    result = json.loads(response.read())
                    assert set(result) == {"attachment_id", "ciphertext_bytes"}
                with opener.open(f"http://{destination}:{port}{suffix}", timeout=20) as response:
                    assert response.headers["Content-Type"] == "application/octet-stream"
                    assert response.headers["Cache-Control"] == "no-store"
                    assert response.read() == ciphertext
            await asyncio.to_thread(transfer_attachment, guest_host, creator_host, b"a")
            await asyncio.to_thread(transfer_attachment, creator_host, guest_host, b"b")

            key_id = pair_key_id(
                room_id,
                [raw_public_key(1), raw_public_key(2)],
            )
            encrypted = {
                "type": "encrypted_message",
                "client_message_id": "creator-encrypted-1",
                "version": "e2ee-v1",
                "algorithm": "AES-256-GCM",
                "key_id": key_id,
                "iv": encode_base64url(b"1" * 12),
                "ciphertext": encode_base64url(b"x" * 4_112),
            }
            await alice.send(json.dumps(encrypted))
            assert (await receive_json(alice))["type"] == "message_ack"
            alice_encrypted = await receive_json(alice)
            bob_encrypted = await receive_json(bob)
            assert alice_encrypted == bob_encrypted
            assert alice_encrypted["type"] == "encrypted_message"
            stored = alice_encrypted["message"]
            assert stored["kind"] == "encrypted_message"
            assert stored["sender_key_id"] == public_key_id(raw_public_key(1))
            assert "text" not in stored

            second_encrypted = {
                **encrypted,
                "client_message_id": "guest-encrypted-1",
                "iv": encode_base64url(b"2" * 12),
                "ciphertext": encode_base64url(b"y" * 4_112),
            }
            await bob.send(json.dumps(second_encrypted))
            assert (await receive_json(bob))["type"] == "message_ack"
            assert (await receive_json(bob))["type"] == "encrypted_message"
            assert (await receive_json(alice))["type"] == "encrypted_message"

            await bob.send(
                json.dumps(
                    {
                        "type": "message",
                        "text": "plaintext downgrade",
                        "client_message_id": "guest-downgrade",
                    }
                )
            )
            downgrade = await receive_json(bob)
            assert downgrade["type"] == "error"
            assert downgrade["code"] == "e2ee_required"

            await bob.send(
                json.dumps(
                    {
                        "type": "bb84_start",
                        "qubit_count": 512,
                        "noise_probability": 0,
                        "intercept_probability": 0,
                        "sample_ratio": 0.1,
                        "qber_threshold": 0.11,
                        "seed": 7,
                    }
                )
            )
            bob_result = await receive_json(bob)
            alice_result = await receive_json(alice)
            assert alice_result == bob_result
            assert alice_result["type"] == "bb84_result"
            assert alice_result["started_by"] == "bob"
            assert alice_result["simulation_only"] is True
            assert alice_result["chat_encryption_active"] is False
            assert alice_result["metrics"]["transmitted"] == 512
            assert len(alice_result["trace"]) <= 24
            post_processing = alice_result["post_processing"]
            assert post_processing["input_bits"] == alice_result["metrics"]["retained"]
            assert post_processing["version"] == "phase3-post-processing-v1"
            assert post_processing["status"] == "completed"
            assert post_processing["reason"] == "completed"
            reconciliation = post_processing["reconciliation"]
            assert reconciliation["algorithm"] == "cascade-inspired-parity-v1"
            assert reconciliation["verified"] is True
            assert reconciliation["remaining_errors"] == 0
            privacy = post_processing["privacy_amplification"]
            assert privacy["algorithm"] == "toeplitz-universal-hash-v1"
            assert privacy["security_margin_bits"] == 32
            assert privacy["estimated_secret_bits"] >= 128
            assert privacy["output_bits"] == 128
            confirmation = post_processing["confirmation"]
            assert confirmation["algorithm"] == "hmac-sha256-truncated-v1"
            assert confirmation["tag_bits"] == 128
            assert confirmation["passed"] is True
            derivation = post_processing["derivation"]
            assert derivation["algorithm"] == "hkdf-sha256-v1"
            assert derivation["output_bits"] == 256
            assert derivation["context_bound"] is True
            assert post_processing["key_material_exposed"] is False
            assert post_processing["key_used_for_chat"] is False
            assert derivation["material_retained"] is False
            assert post_processing["reproducible_teaching_run"] is True
            assert_secret_free(alice_result)
            assert len(json.dumps(alice_result).encode("utf-8")) < 8192

            await bob.close()
            alice_left = await receive_json(alice)
            assert alice_left["type"] == "presence"
            assert alice_left["action"] == "left"
            async with connect(bob_url, proxy=None) as reconnected_bob:
                reconnected = await receive_json(reconnected_bob)
                assert reconnected["type"] == "connected"
                assert reconnected["e2ee_required"] is True
                assert len(reconnected["messages"]) == 4
                assert len(json.dumps(reconnected).encode("utf-8")) > 8_192
                encrypted_history = [
                    message
                    for message in reconnected["messages"]
                    if message["kind"] == "encrypted_message"
                ]
                assert len(encrypted_history) == 2
                assert all("text" not in message for message in encrypted_history)
                assert (await receive_json(reconnected_bob))["type"] == "presence"
                assert (await receive_json(alice))["action"] == "joined"

    print(f"relay smoke passed for {room_id}; bidirectional 2 MiB opaque attachments passed")


if __name__ == "__main__":
    asyncio.run(main())
