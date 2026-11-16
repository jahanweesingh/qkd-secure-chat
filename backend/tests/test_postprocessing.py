from __future__ import annotations

import json
import random
from dataclasses import asdict

import pytest

from app.bb84 import BB84Config, simulate_bb84
from app.postprocessing import (
    CONFIRMATION_ALGORITHM,
    DEFAULT_DERIVED_OUTPUT_BITS,
    DERIVATION_ALGORITHM,
    ENTROPY_MODEL,
    PRIVACY_AMPLIFICATION_ALGORITHM,
    RECONCILIATION_ALGORITHM,
    _derive_context_material,
    binary_entropy,
    cascade_inspired_reconcile,
    confirmation_passes,
    estimate_secret_bits,
    hkdf_sha256,
    run_post_processing,
    toeplitz_hash,
)


def test_binary_entropy_and_illustrative_estimate_known_values() -> None:
    assert binary_entropy(0.0) == 0.0
    assert binary_entropy(0.5) == 1.0
    assert binary_entropy(1.0) == 0.0
    assert binary_entropy(0.11) == pytest.approx(0.499915958164528)
    assert estimate_secret_bits(400, 0.0, 20, security_margin_bits=32) == 348
    assert estimate_secret_bits(400, 0.5, 0, security_margin_bits=0) == 0
    assert estimate_secret_bits(10, 0.0, 50, security_margin_bits=64) == 0


@pytest.mark.parametrize("probability", [-0.01, 1.01, float("nan")])
def test_binary_entropy_rejects_invalid_probability(probability: float) -> None:
    with pytest.raises(ValueError):
        binary_entropy(probability)


def test_toeplitz_hash_known_vector_and_validation() -> None:
    # T[r,c] = seed[(n - 1) + r - c]
    result = toeplitz_hash(
        [1, 0, 1, 1],
        3,
        [1, 0, 1, 1, 0, 1],
    )
    assert result == bytearray([0, 1, 1])

    with pytest.raises(ValueError, match="exactly 6 bits"):
        toeplitz_hash([1, 0, 1, 1], 3, [1, 0])
    with pytest.raises(ValueError, match="only 0 and 1"):
        toeplitz_hash([1, 2], 1, [0, 1])


def test_single_error_reconciliation_counts_every_disclosed_parity() -> None:
    alice = [0] * 8
    bob = alice.copy()
    bob[3] = 1
    outcome = cascade_inspired_reconcile(
        alice,
        bob,
        estimated_qber=0.0,
        rng=random.Random(1),
    )
    try:
        assert outcome.alice_bits == outcome.bob_bits
        assert outcome.metrics.algorithm == RECONCILIATION_ALGORITHM
        assert outcome.metrics.passes == 1
        assert outcome.metrics.corrected_errors == 1
        assert outcome.metrics.remaining_errors == 0
        # One whole-block parity plus log2(8) binary-search parities.
        assert outcome.metrics.leaked_bits == 4
        assert outcome.metrics.verified is True
    finally:
        outcome.wipe()


def test_even_error_pattern_fails_closed_after_bounded_passes() -> None:
    alice = [0] * 8
    bob = alice.copy()
    bob[1] = bob[6] = 1
    outcome = cascade_inspired_reconcile(
        alice,
        bob,
        estimated_qber=0.0,
        rng=random.Random(3),
    )
    try:
        assert outcome.metrics.passes == 6
        assert outcome.metrics.corrected_errors == 0
        assert outcome.metrics.remaining_errors == 2
        assert outcome.metrics.leaked_bits == 6
        assert outcome.metrics.verified is False
    finally:
        outcome.wipe()


def test_confirmation_is_constant_contract_and_rejects_tampering() -> None:
    bits = [index % 2 for index in range(256)]
    assert confirmation_passes(
        bits,
        bits,
        room_id="room-one",
        session_id="sim-one",
    )
    changed = bits.copy()
    changed[0] ^= 1
    assert not confirmation_passes(
        bits,
        changed,
        room_id="room-one",
        session_id="sim-one",
    )


def test_hkdf_known_rfc5869_vector_and_context_binding() -> None:
    output = hkdf_sha256(
        bytes.fromhex("0b" * 22),
        salt=bytes.fromhex("000102030405060708090a0b0c"),
        info=bytes.fromhex("f0f1f2f3f4f5f6f7f8f9"),
        length=42,
    )
    assert output.hex() == (
        "3cb25f25faacd57a90434f64d0362f2a"
        "2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
        "34007208d5b887185865"
    )

    bits = [index % 2 for index in range(256)]
    first = _derive_context_material(bits, room_id="room-a", session_id="sim-a")
    same = _derive_context_material(bits, room_id="room-a", session_id="sim-a")
    other_room = _derive_context_material(bits, room_id="room-b", session_id="sim-a")
    other_session = _derive_context_material(bits, room_id="room-a", session_id="sim-b")
    try:
        assert first == same
        assert first != other_room
        assert first != other_session
        assert len(first) * 8 == DEFAULT_DERIVED_OUTPUT_BITS
    finally:
        for value in (first, same, other_room, other_session, output):
            value.clear()


def test_completed_pipeline_is_redacted_and_consumes_input_buffers() -> None:
    alice = bytearray(index % 2 for index in range(400))
    bob = bytearray(alice)
    report = run_post_processing(
        alice,
        bob,
        bb84_accepted=True,
        observed_qber=0.0,
        room_id="demo-room",
        session_id="sim-completed",
        teaching_seed=99,
    )

    assert alice == bob == bytearray()
    assert report.status == "completed"
    assert report.reason == "completed"
    assert report.input_bits == 400
    assert report.reconciliation.verified is True
    assert report.privacy_amplification.output_bits == 128
    assert report.confirmation.passed is True
    assert report.derivation.output_bits == 256
    assert report.derivation.context_bound is True
    assert report.derivation.material_retained is False

    payload = report.public_payload()
    assert payload["key_material_exposed"] is False
    assert payload["key_used_for_chat"] is False
    assert payload["reproducible_teaching_run"] is True
    assert json.loads(json.dumps(payload)) == payload
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

    def walk(value: object) -> None:
        if isinstance(value, dict):
            assert forbidden_keys.isdisjoint(value)
            for nested in value.values():
                walk(nested)
        elif isinstance(value, list):
            for nested in value:
                walk(nested)

    walk(payload)


def test_aborted_session_skips_pipeline_and_wipes_candidates() -> None:
    alice = bytearray([0, 1, 0, 1])
    bob = bytearray([0, 0, 0, 1])
    report = run_post_processing(
        alice,
        bob,
        bb84_accepted=False,
        observed_qber=0.25,
        room_id="demo-room",
        session_id="sim-aborted",
        teaching_seed=None,
    )
    assert alice == bob == bytearray()
    assert report.status == "skipped"
    assert report.reason == "bb84_not_accepted"
    assert report.reconciliation.passes == 0
    assert report.privacy_amplification.output_bits == 0
    assert report.confirmation.passed is False
    assert report.derivation.material_retained is False


def test_short_accepted_candidate_reports_insufficient_entropy() -> None:
    alice = bytearray([0] * 128)
    bob = bytearray(alice)
    report = run_post_processing(
        alice,
        bob,
        bb84_accepted=True,
        observed_qber=0.0,
        room_id="demo-room",
        session_id="sim-short",
        teaching_seed=7,
    )
    assert report.status == "failed"
    assert report.reason == "insufficient_entropy"
    assert report.reconciliation.verified is True
    assert 0 <= report.privacy_amplification.estimated_secret_bits < 128
    assert report.privacy_amplification.output_bits == 0
    assert report.derivation.output_bits == 0


def test_pipeline_reports_injected_confirmation_failure_and_wipes_inputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = bytearray([0] * 400)
    bob = bytearray(alice)
    amplified: list[bytearray] = []

    def reject_confirmation(
        alice_bits: bytearray,
        bob_bits: bytearray,
        **kwargs: object,
    ) -> bool:
        amplified.extend((alice_bits, bob_bits))
        return False

    monkeypatch.setattr(
        "app.postprocessing.confirmation_passes",
        reject_confirmation,
    )

    report = run_post_processing(
        alice,
        bob,
        bb84_accepted=True,
        observed_qber=0.0,
        room_id="demo-room",
        session_id="sim-confirmation-fault",
        teaching_seed=11,
    )

    assert alice == bob == bytearray()
    assert amplified == [bytearray(), bytearray()]
    assert report.status == "failed"
    assert report.reason == "confirmation_failed"
    assert report.reconciliation.verified is True
    assert report.privacy_amplification.output_bits == 128
    assert report.confirmation.passed is False
    assert report.derivation.output_bits == 0
    assert report.derivation.context_bound is False
    assert report.derivation.material_retained is False


def test_pipeline_reports_injected_derivation_failure_truthfully(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = bytearray([0] * 400)
    bob = bytearray(alice)
    alice_derived = bytearray([0] * 32)
    bob_derived = bytearray([1] * 32)
    outputs = iter((alice_derived, bob_derived))

    def mismatched_derivation(*args: object, **kwargs: object) -> bytearray:
        return next(outputs)

    monkeypatch.setattr(
        "app.postprocessing._derive_context_material",
        mismatched_derivation,
    )

    report = run_post_processing(
        alice,
        bob,
        bb84_accepted=True,
        observed_qber=0.0,
        room_id="demo-room",
        session_id="sim-derivation-fault",
        teaching_seed=12,
    )

    assert alice == bob == bytearray()
    assert alice_derived == bob_derived == bytearray()
    assert report.status == "failed"
    assert report.reason == "derivation_failed"
    assert report.reconciliation.verified is True
    assert report.privacy_amplification.output_bits == 128
    assert report.confirmation.passed is True
    assert report.derivation.output_bits == 0
    assert report.derivation.context_bound is False
    assert report.derivation.material_retained is False


def test_unresolved_reconciliation_is_a_distinct_failed_outcome() -> None:
    alice = bytearray([0] * 8)
    bob = bytearray(alice)
    bob[1] = bob[6] = 1
    report = run_post_processing(
        alice,
        bob,
        bb84_accepted=True,
        observed_qber=0.0,
        room_id="demo-room",
        session_id="sim-reconciliation-failure",
        teaching_seed=3,
    )
    assert alice == bob == bytearray()
    assert report.status == "failed"
    assert report.reason == "reconciliation_failed"
    assert report.reconciliation.remaining_errors == 2
    assert report.reconciliation.verified is False
    assert report.privacy_amplification.output_bits == 0
    assert report.confirmation.passed is False


def test_bb84_candidate_transcript_is_private_consumable_and_redacted() -> None:
    simulation = simulate_bb84(BB84Config(qubit_count=128, seed=7))
    assert simulation.private_candidate_material_retained is True
    representation = repr(simulation)
    assert "alice_bits" not in representation
    assert "bob_bits" not in representation

    public = simulation.public_payload()
    serialized = json.dumps(public, sort_keys=True)
    assert "candidate" not in serialized.lower()
    assert "alice_bit" not in serialized
    assert "bob_bit" not in serialized
    with pytest.raises(TypeError, match="cannot be copied or serialized"):
        asdict(simulation)

    alice, bob = simulation.consume_private_candidate_bits()
    try:
        assert len(alice) == len(bob) == simulation.metrics.retained
        assert simulation.private_candidate_material_retained is False
        with pytest.raises(RuntimeError, match="already consumed"):
            simulation.consume_private_candidate_bits()
    finally:
        alice.clear()
        bob.clear()


def test_report_uses_stable_algorithm_names() -> None:
    report = run_post_processing(
        bytearray([0] * 400),
        bytearray([0] * 400),
        bb84_accepted=True,
        observed_qber=0.0,
        room_id="room",
        session_id="session",
        teaching_seed=1,
    )
    assert report.reconciliation.algorithm == RECONCILIATION_ALGORITHM
    assert report.privacy_amplification.algorithm == PRIVACY_AMPLIFICATION_ALGORITHM
    assert report.privacy_amplification.entropy_model == ENTROPY_MODEL
    assert report.confirmation.algorithm == CONFIRMATION_ALGORITHM
    assert report.derivation.algorithm == DERIVATION_ALGORITHM
