"""Bounded educational BB84 post-processing.

This module models the classical stages which follow sifting: a small
Cascade-inspired parity reconciliation, leakage accounting, an illustrative
asymptotic BB84 entropy estimate, Toeplitz privacy amplification, confirmation
and context-bound derivation.

It is deliberately not a finite-key security proof and it does not make the
software simulator equivalent to physical QKD. Secret bit sequences and
derived bytes remain process-local and are overwritten on a best-effort basis
before this module returns. Only :class:`PostProcessingReport` is public.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import random
from dataclasses import asdict, dataclass, field
from typing import Literal, Protocol, Sequence


POST_PROCESSING_VERSION = "phase3-post-processing-v1"
RECONCILIATION_ALGORITHM = "cascade-inspired-parity-v1"
PRIVACY_AMPLIFICATION_ALGORITHM = "toeplitz-universal-hash-v1"
ENTROPY_MODEL = "illustrative-asymptotic-bb84-binary-entropy-v1"
CONFIRMATION_ALGORITHM = "hmac-sha256-truncated-v1"
DERIVATION_ALGORITHM = "hkdf-sha256-v1"

DEFAULT_RECONCILIATION_PASSES = 6
DEFAULT_SECURITY_MARGIN_BITS = 32
DEFAULT_CONFIRMATION_TAG_BITS = 128
DEFAULT_PRIVACY_OUTPUT_BITS = 128
DEFAULT_DERIVED_OUTPUT_BITS = 256

PostProcessingStatus = Literal["completed", "skipped", "failed"]
PostProcessingReason = Literal[
    "completed",
    "bb84_not_accepted",
    "reconciliation_failed",
    "insufficient_entropy",
    "confirmation_failed",
    "derivation_failed",
]


class PermutationRandom(Protocol):
    def randrange(self, stop: int) -> int: ...

    def sample(self, population: Sequence[int], k: int) -> list[int]: ...


def _validate_bits(bits: Sequence[int], name: str) -> None:
    if any(bit not in (0, 1) for bit in bits):
        raise ValueError(f"{name} must contain only 0 and 1")


def _wipe(buffer: bytearray) -> None:
    for index in range(len(buffer)):
        buffer[index] = 0
    buffer.clear()


@dataclass(frozen=True, slots=True)
class ReconciliationMetrics:
    algorithm: str
    passes: int
    corrected_errors: int
    remaining_errors: int
    leaked_bits: int
    verified: bool

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class PrivacyAmplificationMetrics:
    algorithm: str
    entropy_model: str
    security_margin_bits: int
    estimated_secret_bits: int
    output_bits: int

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ConfirmationMetrics:
    algorithm: str
    tag_bits: int
    passed: bool

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class DerivationMetrics:
    algorithm: str
    output_bits: int
    context_bound: bool
    material_retained: bool

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class PostProcessingReport:
    """Fixed, redacted report which is safe to serialize to clients."""

    status: PostProcessingStatus
    reason: PostProcessingReason
    input_bits: int
    reconciliation: ReconciliationMetrics
    privacy_amplification: PrivacyAmplificationMetrics
    confirmation: ConfirmationMetrics
    derivation: DerivationMetrics
    key_material_exposed: bool = False
    key_used_for_chat: bool = False
    reproducible_teaching_run: bool = False

    def public_payload(self) -> dict[str, object]:
        return {
            "version": POST_PROCESSING_VERSION,
            "status": self.status,
            "reason": self.reason,
            "input_bits": self.input_bits,
            "reconciliation": self.reconciliation.as_dict(),
            "privacy_amplification": self.privacy_amplification.as_dict(),
            "confirmation": self.confirmation.as_dict(),
            "derivation": self.derivation.as_dict(),
            "key_material_exposed": False,
            "key_used_for_chat": False,
            "reproducible_teaching_run": self.reproducible_teaching_run,
        }


@dataclass(slots=True)
class _ReconciliationOutcome:
    alice_bits: bytearray = field(repr=False)
    bob_bits: bytearray = field(repr=False)
    metrics: ReconciliationMetrics

    def wipe(self) -> None:
        _wipe(self.alice_bits)
        _wipe(self.bob_bits)


def _parity(bits: Sequence[int], indices: Sequence[int]) -> int:
    parity = 0
    for index in indices:
        parity ^= bits[index]
    return parity


def _base_block_size(estimated_qber: float, bit_count: int) -> int:
    if bit_count <= 0:
        return 1
    if estimated_qber <= 0.0:
        proposed = 64
    else:
        proposed = round(0.73 / min(estimated_qber, 0.5))
    return max(4, min(64, bit_count, proposed))


def _correct_odd_parity_block(
    alice_bits: Sequence[int],
    bob_bits: bytearray,
    block: Sequence[int],
) -> tuple[int, int]:
    """Locate and flip one odd-parity error.

    The caller has already disclosed the whole-block Alice parity. Each split
    below discloses exactly one further Alice parity bit, which is returned as
    leakage. Bob's locally calculated parities do not add public information.
    """

    candidates = list(block)
    leaked_bits = 0
    while len(candidates) > 1:
        midpoint = len(candidates) // 2
        left = candidates[:midpoint]
        leaked_bits += 1
        if _parity(alice_bits, left) != _parity(bob_bits, left):
            candidates = left
        else:
            candidates = candidates[midpoint:]
    if not candidates:
        return 0, leaked_bits
    bob_bits[candidates[0]] ^= 1
    return 1, leaked_bits


def cascade_inspired_reconcile(
    alice_bits: Sequence[int],
    bob_bits: Sequence[int],
    *,
    estimated_qber: float,
    rng: PermutationRandom,
    passes: int = DEFAULT_RECONCILIATION_PASSES,
) -> _ReconciliationOutcome:
    """Run a bounded multi-pass, randomly permuted parity reconciliation.

    This intentionally uses the name *Cascade-inspired*: it uses Cascade's
    shuffled parity blocks and binary searches but omits recursive look-back.
    Every Alice parity disclosed by this model is counted exactly once.
    """

    if len(alice_bits) != len(bob_bits):
        raise ValueError("candidate bit sequences must have equal length")
    _validate_bits(alice_bits, "alice_bits")
    _validate_bits(bob_bits, "bob_bits")
    if not math.isfinite(estimated_qber) or not 0.0 <= estimated_qber <= 1.0:
        raise ValueError("estimated_qber must be between 0 and 1")
    if isinstance(passes, bool) or not isinstance(passes, int) or not 1 <= passes <= 8:
        raise ValueError("passes must be an integer between 1 and 8")

    alice = bytearray(alice_bits)
    bob = bytearray(bob_bits)
    bit_count = len(alice)
    if bit_count == 0:
        return _ReconciliationOutcome(
            alice,
            bob,
            ReconciliationMetrics(
                algorithm=RECONCILIATION_ALGORITHM,
                passes=0,
                corrected_errors=0,
                remaining_errors=0,
                leaked_bits=0,
                verified=False,
            ),
        )

    base_block_size = _base_block_size(estimated_qber, bit_count)
    corrected_errors = 0
    leaked_bits = 0
    executed_passes = 0

    for pass_index in range(passes):
        permutation = (
            list(range(bit_count))
            if pass_index == 0
            else rng.sample(range(bit_count), k=bit_count)
        )
        block_size = min(bit_count, base_block_size * (2**pass_index))
        executed_passes += 1
        for offset in range(0, bit_count, block_size):
            block = permutation[offset : offset + block_size]
            # Alice announces one parity per block. This is the public leakage
            # accounted for here; Bob compares it with his local parity.
            leaked_bits += 1
            if _parity(alice, block) != _parity(bob, block):
                corrected, binary_search_leak = _correct_odd_parity_block(
                    alice,
                    bob,
                    block,
                )
                corrected_errors += corrected
                leaked_bits += binary_search_leak

        if alice == bob:
            break

    remaining_errors = sum(
        left != right for left, right in zip(alice, bob, strict=True)
    )
    return _ReconciliationOutcome(
        alice,
        bob,
        ReconciliationMetrics(
            algorithm=RECONCILIATION_ALGORITHM,
            passes=executed_passes,
            corrected_errors=corrected_errors,
            remaining_errors=remaining_errors,
            leaked_bits=leaked_bits,
            verified=remaining_errors == 0,
        ),
    )


def binary_entropy(probability: float) -> float:
    """Return the binary entropy h2(p)."""

    if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
        raise ValueError("probability must be between 0 and 1")
    if probability in (0.0, 1.0):
        return 0.0
    return -probability * math.log2(probability) - (
        1.0 - probability
    ) * math.log2(1.0 - probability)


def estimate_secret_bits(
    input_bits: int,
    observed_qber: float,
    leaked_bits: int,
    *,
    security_margin_bits: int = DEFAULT_SECURITY_MARGIN_BITS,
) -> int:
    """Illustrative asymptotic BB84 entropy estimate with finite deductions.

    ``floor(n * (1 - h2(Q)) - leak_ec - margin)`` is useful for teaching how
    errors and disclosed parity reduce usable material. It is not a composable
    finite-key proof and must not be presented as one.
    """

    for value, name in (
        (input_bits, "input_bits"),
        (leaked_bits, "leaked_bits"),
        (security_margin_bits, "security_margin_bits"),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{name} must be a non-negative integer")
    if (
        isinstance(observed_qber, bool)
        or not isinstance(observed_qber, (int, float))
        or not math.isfinite(observed_qber)
        or not 0.0 <= observed_qber <= 1.0
    ):
        raise ValueError("observed_qber must be between 0 and 1")
    estimate = math.floor(
        input_bits * (1.0 - binary_entropy(min(observed_qber, 0.5)))
        - leaked_bits
        - security_margin_bits
    )
    return max(0, min(input_bits, estimate))


def toeplitz_hash(
    input_bits: Sequence[int],
    output_bits: int,
    seed_bits: Sequence[int],
) -> bytearray:
    """Apply a binary Toeplitz universal hash to a bit vector."""

    _validate_bits(input_bits, "input_bits")
    _validate_bits(seed_bits, "seed_bits")
    if (
        isinstance(output_bits, bool)
        or not isinstance(output_bits, int)
        or output_bits <= 0
    ):
        raise ValueError("output_bits must be a positive integer")
    required_seed_bits = len(input_bits) + output_bits - 1
    if len(seed_bits) != required_seed_bits:
        raise ValueError(
            f"seed_bits must contain exactly {required_seed_bits} bits"
        )

    result = bytearray(output_bits)
    for row in range(output_bits):
        value = 0
        for column, bit in enumerate(input_bits):
            value ^= bit & seed_bits[len(input_bits) - 1 + row - column]
        result[row] = value
    return result


def _bits_to_bytes(bits: Sequence[int]) -> bytearray:
    _validate_bits(bits, "bits")
    if len(bits) % 8 != 0:
        raise ValueError("bit sequence length must be a multiple of 8")
    packed = bytearray(len(bits) // 8)
    for index, bit in enumerate(bits):
        packed[index // 8] |= bit << (7 - (index % 8))
    return packed


def _context_bytes(room_id: str, session_id: str) -> bytes:
    if not room_id or not session_id:
        raise ValueError("room_id and session_id must not be empty")
    values = (POST_PROCESSING_VERSION.encode(), room_id.encode(), session_id.encode())
    encoded = bytearray(b"BB84-CHAT-CONTEXT\x00")
    for value in values:
        if len(value) > 65_535:
            raise ValueError("context component is too long")
        encoded.extend(len(value).to_bytes(2, "big"))
        encoded.extend(value)
    return bytes(encoded)


def hkdf_sha256(
    input_key_material: bytes | bytearray,
    *,
    salt: bytes,
    info: bytes,
    length: int,
) -> bytearray:
    """RFC 5869 HKDF-SHA-256 implemented with the standard library."""

    if not input_key_material:
        raise ValueError("input_key_material must not be empty")
    if not 1 <= length <= 255 * hashlib.sha256().digest_size:
        raise ValueError("length is outside the HKDF-SHA-256 range")
    effective_salt = salt or bytes(hashlib.sha256().digest_size)
    pseudo_random_key = bytearray(
        hmac.new(
            effective_salt,
            bytes(input_key_material),
            hashlib.sha256,
        ).digest()
    )
    output = bytearray()
    previous = bytearray()
    counter = 1
    try:
        while len(output) < length:
            previous[:] = hmac.new(
                bytes(pseudo_random_key),
                bytes(previous) + info + bytes((counter,)),
                hashlib.sha256,
            ).digest()
            output.extend(previous)
            counter += 1
    finally:
        _wipe(pseudo_random_key)
        _wipe(previous)
    del output[length:]
    return output


def confirmation_passes(
    alice_bits: Sequence[int],
    bob_bits: Sequence[int],
    *,
    room_id: str,
    session_id: str,
    tag_bits: int = DEFAULT_CONFIRMATION_TAG_BITS,
) -> bool:
    """Confirm two amplified keys using a truncated HMAC and constant-time compare."""

    if tag_bits % 8 != 0 or not 64 <= tag_bits <= 256:
        raise ValueError("tag_bits must be a multiple of 8 between 64 and 256")
    alice_material = bytearray()
    bob_material = bytearray()
    alice_confirmation_key = bytearray()
    bob_confirmation_key = bytearray()
    try:
        alice_material = _bits_to_bytes(alice_bits)
        bob_material = _bits_to_bytes(bob_bits)
        context_digest = hashlib.sha256(_context_bytes(room_id, session_id)).digest()
        alice_confirmation_key = hkdf_sha256(
            alice_material,
            salt=context_digest,
            info=b"BB84-CHAT-CONFIRMATION-KEY\x00",
            length=32,
        )
        bob_confirmation_key = hkdf_sha256(
            bob_material,
            salt=context_digest,
            info=b"BB84-CHAT-CONFIRMATION-KEY\x00",
            length=32,
        )
        tag_length = tag_bits // 8
        expected_tag = hmac.new(
            bytes(alice_confirmation_key),
            b"BB84-CHAT-CONFIRM\x00" + context_digest,
            hashlib.sha256,
        ).digest()[:tag_length]
        received_tag = hmac.new(
            bytes(bob_confirmation_key),
            b"BB84-CHAT-CONFIRM\x00" + context_digest,
            hashlib.sha256,
        ).digest()[:tag_length]
        return hmac.compare_digest(expected_tag, received_tag)
    finally:
        _wipe(alice_material)
        _wipe(bob_material)
        _wipe(alice_confirmation_key)
        _wipe(bob_confirmation_key)


def _derive_context_material(
    secret_bits: Sequence[int],
    *,
    room_id: str,
    session_id: str,
    output_bits: int = DEFAULT_DERIVED_OUTPUT_BITS,
) -> bytearray:
    """Derive context-bound bytes for the internal teaching pipeline."""

    if output_bits % 8 != 0 or not 8 <= output_bits <= 2048:
        raise ValueError("output_bits must be a multiple of 8 between 8 and 2048")
    packed = _bits_to_bytes(secret_bits)
    try:
        context_digest = hashlib.sha256(_context_bytes(room_id, session_id)).digest()
        return hkdf_sha256(
            packed,
            salt=context_digest,
            info=b"BB84-CHAT-APPLICATION-MATERIAL\x00",
            length=output_bits // 8,
        )
    finally:
        _wipe(packed)


def _empty_report(
    *,
    status: PostProcessingStatus,
    reason: PostProcessingReason,
    input_bits: int,
    reproducible_teaching_run: bool,
    reconciliation: ReconciliationMetrics | None = None,
    estimated_secret_bits: int = 0,
    privacy_output_bits: int = 0,
    confirmation_passed: bool = False,
) -> PostProcessingReport:
    return PostProcessingReport(
        status=status,
        reason=reason,
        input_bits=input_bits,
        reconciliation=reconciliation
        or ReconciliationMetrics(
            algorithm=RECONCILIATION_ALGORITHM,
            passes=0,
            corrected_errors=0,
            remaining_errors=0,
            leaked_bits=0,
            verified=False,
        ),
        privacy_amplification=PrivacyAmplificationMetrics(
            algorithm=PRIVACY_AMPLIFICATION_ALGORITHM,
            entropy_model=ENTROPY_MODEL,
            security_margin_bits=DEFAULT_SECURITY_MARGIN_BITS,
            estimated_secret_bits=estimated_secret_bits,
            output_bits=privacy_output_bits,
        ),
        confirmation=ConfirmationMetrics(
            algorithm=CONFIRMATION_ALGORITHM,
            tag_bits=DEFAULT_CONFIRMATION_TAG_BITS,
            passed=confirmation_passed,
        ),
        derivation=DerivationMetrics(
            algorithm=DERIVATION_ALGORITHM,
            output_bits=0,
            context_bound=False,
            material_retained=False,
        ),
        key_material_exposed=False,
        key_used_for_chat=False,
        reproducible_teaching_run=reproducible_teaching_run,
    )


def run_post_processing(
    alice_candidate_bits: bytearray,
    bob_candidate_bits: bytearray,
    *,
    bb84_accepted: bool,
    observed_qber: float | None,
    room_id: str,
    session_id: str,
    teaching_seed: int | None,
) -> PostProcessingReport:
    """Process one private candidate transcript and return redacted metrics only.

    Ownership of both bytearrays transfers to this function. They are cleared
    on every return path, including skipped and failed sessions.
    """

    if len(alice_candidate_bits) != len(bob_candidate_bits):
        _wipe(alice_candidate_bits)
        _wipe(bob_candidate_bits)
        raise ValueError("candidate bit sequences must have equal length")
    input_bits = len(alice_candidate_bits)
    reproducible = teaching_seed is not None
    reconciliation: _ReconciliationOutcome | None = None
    amplified_alice = bytearray()
    amplified_bob = bytearray()
    toeplitz_seed = bytearray()
    derived_alice = bytearray()
    derived_bob = bytearray()

    try:
        if not bb84_accepted:
            return _empty_report(
                status="skipped",
                reason="bb84_not_accepted",
                input_bits=input_bits,
                reproducible_teaching_run=reproducible,
            )
        if observed_qber is None:
            return _empty_report(
                status="failed",
                reason="insufficient_entropy",
                input_bits=input_bits,
                reproducible_teaching_run=reproducible,
            )

        rng: PermutationRandom
        if teaching_seed is None:
            rng = random.SystemRandom()
        else:
            # Domain-separated only for reproducible classroom behaviour. This
            # is never a production key-generation seed.
            rng = random.Random(teaching_seed ^ 0x504F535450524F43)

        reconciliation = cascade_inspired_reconcile(
            alice_candidate_bits,
            bob_candidate_bits,
            estimated_qber=observed_qber,
            rng=rng,
        )
        if not reconciliation.metrics.verified:
            return _empty_report(
                status="failed",
                reason="reconciliation_failed",
                input_bits=input_bits,
                reproducible_teaching_run=reproducible,
                reconciliation=reconciliation.metrics,
            )

        estimated_secret_bits = estimate_secret_bits(
            input_bits,
            observed_qber,
            reconciliation.metrics.leaked_bits,
        )
        if estimated_secret_bits < DEFAULT_PRIVACY_OUTPUT_BITS:
            return _empty_report(
                status="failed",
                reason="insufficient_entropy",
                input_bits=input_bits,
                reproducible_teaching_run=reproducible,
                reconciliation=reconciliation.metrics,
                estimated_secret_bits=estimated_secret_bits,
            )

        output_bits = DEFAULT_PRIVACY_OUTPUT_BITS
        toeplitz_seed = bytearray(
            rng.randrange(2)
            for _ in range(input_bits + output_bits - 1)
        )
        amplified_alice = toeplitz_hash(
            reconciliation.alice_bits,
            output_bits,
            toeplitz_seed,
        )
        amplified_bob = toeplitz_hash(
            reconciliation.bob_bits,
            output_bits,
            toeplitz_seed,
        )

        confirmed = confirmation_passes(
            amplified_alice,
            amplified_bob,
            room_id=room_id,
            session_id=session_id,
        )
        if not confirmed:
            return _empty_report(
                status="failed",
                reason="confirmation_failed",
                input_bits=input_bits,
                reproducible_teaching_run=reproducible,
                reconciliation=reconciliation.metrics,
                estimated_secret_bits=estimated_secret_bits,
                privacy_output_bits=output_bits,
            )

        derived_alice = _derive_context_material(
            amplified_alice,
            room_id=room_id,
            session_id=session_id,
        )
        derived_bob = _derive_context_material(
            amplified_bob,
            room_id=room_id,
            session_id=session_id,
        )
        if not hmac.compare_digest(derived_alice, derived_bob):
            return _empty_report(
                status="failed",
                reason="derivation_failed",
                input_bits=input_bits,
                reproducible_teaching_run=reproducible,
                reconciliation=reconciliation.metrics,
                estimated_secret_bits=estimated_secret_bits,
                privacy_output_bits=output_bits,
                confirmation_passed=True,
            )

        return PostProcessingReport(
            status="completed",
            reason="completed",
            input_bits=input_bits,
            reconciliation=reconciliation.metrics,
            privacy_amplification=PrivacyAmplificationMetrics(
                algorithm=PRIVACY_AMPLIFICATION_ALGORITHM,
                entropy_model=ENTROPY_MODEL,
                security_margin_bits=DEFAULT_SECURITY_MARGIN_BITS,
                estimated_secret_bits=estimated_secret_bits,
                output_bits=output_bits,
            ),
            confirmation=ConfirmationMetrics(
                algorithm=CONFIRMATION_ALGORITHM,
                tag_bits=DEFAULT_CONFIRMATION_TAG_BITS,
                passed=True,
            ),
            derivation=DerivationMetrics(
                algorithm=DERIVATION_ALGORITHM,
                output_bits=DEFAULT_DERIVED_OUTPUT_BITS,
                context_bound=True,
                material_retained=False,
            ),
            key_material_exposed=False,
            key_used_for_chat=False,
            reproducible_teaching_run=reproducible,
        )
    finally:
        _wipe(alice_candidate_bits)
        _wipe(bob_candidate_bits)
        if reconciliation is not None:
            reconciliation.wipe()
        _wipe(amplified_alice)
        _wipe(amplified_bob)
        _wipe(toeplitz_seed)
        _wipe(derived_alice)
        _wipe(derived_bob)
