"""Pure classical BB84 teaching model.

This module emulates protocol choices and measurements with ordinary software.
It does not control quantum hardware, establish a production key, authenticate
the public discussion, or encrypt chat messages.
"""

from __future__ import annotations

import math
import random
from dataclasses import asdict, dataclass, field
from typing import Literal, Protocol, Sequence

Basis = Literal["Z", "X"]
DecisionStatus = Literal["accepted", "aborted"]
SampleComparison = Literal["match", "mismatch"]
MAX_SAFE_INTEGER_SEED = 2**53 - 1
MAX_PUBLIC_TRACE_ROWS = 24
MAX_PUBLIC_SAMPLED_TRACE_ROWS = 12


class RandomSource(Protocol):
    def randrange(self, stop: int) -> int: ...

    def random(self) -> float: ...

    def sample(self, population: Sequence[int], k: int) -> list[int]: ...


@dataclass(frozen=True, slots=True)
class BB84Config:
    qubit_count: int = 512
    noise_probability: float = 0.0
    intercept_probability: float = 0.0
    sample_ratio: float = 0.25
    qber_threshold: float = 0.11
    seed: int | None = None

    def __post_init__(self) -> None:
        if (
            isinstance(self.qubit_count, bool)
            or not isinstance(self.qubit_count, int)
            or self.qubit_count not in {128, 256, 512, 1024}
        ):
            raise ValueError("qubit_count must be 128, 256, 512, or 1024")
        _validate_bounded_number(
            self.noise_probability, "noise_probability", 0.0, 0.25
        )
        _validate_bounded_number(
            self.intercept_probability, "intercept_probability", 0.0, 1.0
        )
        _validate_bounded_number(self.sample_ratio, "sample_ratio", 0.1, 0.5)
        _validate_bounded_number(
            self.qber_threshold, "qber_threshold", 0.01, 0.25
        )
        if self.seed is not None:
            if isinstance(self.seed, bool) or not isinstance(self.seed, int):
                raise ValueError("seed must be an integer")
            if not 0 <= self.seed <= MAX_SAFE_INTEGER_SEED:
                raise ValueError(
                    f"seed must be between 0 and {MAX_SAFE_INTEGER_SEED}"
                )

    def as_dict(self) -> dict[str, int | float | None]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class BB84Metrics:
    transmitted: int
    intercepted: int
    sifted: int
    sample: int
    mismatches: int
    qber: float | None
    retained: int

    def as_dict(self) -> dict[str, int | float | None]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class BB84Decision:
    status: DecisionStatus
    reason: str

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class BB84TraceRow:
    index: int
    alice_basis: Basis
    bob_basis: Basis
    basis_match: bool
    intercepted: bool
    sampled: bool
    sample_comparison: SampleComparison | None

    def as_dict(self) -> dict[str, int | str | bool | None]:
        return asdict(self)


class _PrivateCandidateTranscript:
    """Process-local candidate material which is never part of public output."""

    __slots__ = ("alice_bits", "bob_bits", "consumed")

    def __init__(self, alice_bits: bytearray, bob_bits: bytearray) -> None:
        self.alice_bits = alice_bits
        self.bob_bits = bob_bits
        self.consumed = False

    def __repr__(self) -> str:
        return (
            "_PrivateCandidateTranscript("
            f"length={len(self.alice_bits)}, consumed={self.consumed}, redacted=True)"
        )

    def consume(self) -> tuple[bytearray, bytearray]:
        if self.consumed:
            raise RuntimeError("private candidate transcript was already consumed")
        self.consumed = True
        alice_bits = self.alice_bits
        bob_bits = self.bob_bits
        self.alice_bits = bytearray()
        self.bob_bits = bytearray()
        return alice_bits, bob_bits

    def __deepcopy__(self, memo: dict[int, object]) -> object:
        del memo
        raise TypeError("private candidate transcript cannot be copied or serialized")

    def __reduce_ex__(self, protocol: int) -> object:
        del protocol
        raise TypeError("private candidate transcript cannot be pickled")

    def discard(self) -> None:
        for bits in (self.alice_bits, self.bob_bits):
            for index in range(len(bits)):
                bits[index] = 0
            bits.clear()
        self.consumed = True


@dataclass(frozen=True, slots=True)
class BB84SimulationResult:
    config: BB84Config
    metrics: BB84Metrics
    decision: BB84Decision
    trace: tuple[BB84TraceRow, ...]
    _private_candidate_transcript: _PrivateCandidateTranscript = field(
        repr=False,
        compare=False,
    )

    def public_payload(self) -> dict[str, object]:
        """Return non-key diagnostics suitable for the educational dashboard."""

        return {
            "config": self.config.as_dict(),
            "metrics": self.metrics.as_dict(),
            "decision": self.decision.as_dict(),
            "trace": [row.as_dict() for row in self.trace],
        }

    def consume_private_candidate_bits(self) -> tuple[bytearray, bytearray]:
        """Transfer private candidate material to the post-processing stage."""

        return self._private_candidate_transcript.consume()

    def discard_private_candidate_bits(self) -> None:
        """Best-effort clearing for a result which will not be post-processed."""

        self._private_candidate_transcript.discard()

    @property
    def private_candidate_material_retained(self) -> bool:
        return not self._private_candidate_transcript.consumed


def _validate_bounded_number(
    value: object,
    name: str,
    minimum: float,
    maximum: float,
) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")


def _validate_bits(bits: Sequence[int], name: str) -> None:
    if any(bit not in (0, 1) for bit in bits):
        raise ValueError(f"{name} must contain only 0 and 1")


def _validate_bases(bases: Sequence[Basis], name: str) -> None:
    if any(basis not in ("Z", "X") for basis in bases):
        raise ValueError(f"{name} must contain only Z and X")


def sift_indices(
    alice_bases: Sequence[Basis], bob_bases: Sequence[Basis]
) -> tuple[int, ...]:
    """Return positions where Alice and Bob selected the same basis."""

    if len(alice_bases) != len(bob_bases):
        raise ValueError("basis sequences must have equal length")
    _validate_bases(alice_bases, "alice_bases")
    _validate_bases(bob_bases, "bob_bases")
    return tuple(
        index
        for index, (alice_basis, bob_basis) in enumerate(
            zip(alice_bases, bob_bases, strict=True)
        )
        if alice_basis == bob_basis
    )


def calculate_qber(
    alice_bits: Sequence[int],
    bob_bits: Sequence[int],
    disclosed_indices: Sequence[int],
) -> tuple[int, float | None]:
    """Count disclosed mismatches and calculate their QBER.

    QBER is undefined when no positions are disclosed, represented as ``None``.
    """

    if len(alice_bits) != len(bob_bits):
        raise ValueError("bit sequences must have equal length")
    _validate_bits(alice_bits, "alice_bits")
    _validate_bits(bob_bits, "bob_bits")
    if any(index < 0 or index >= len(alice_bits) for index in disclosed_indices):
        raise ValueError("disclosed index is out of range")
    if len(set(disclosed_indices)) != len(disclosed_indices):
        raise ValueError("disclosed indices must be unique")
    if not disclosed_indices:
        return 0, None
    mismatches = sum(
        alice_bits[index] != bob_bits[index] for index in disclosed_indices
    )
    return mismatches, mismatches / len(disclosed_indices)


def _random_basis(rng: RandomSource) -> Basis:
    return "Z" if rng.randrange(2) == 0 else "X"


def _measure(
    prepared_bit: int,
    prepared_basis: Basis,
    measurement_basis: Basis,
    rng: RandomSource,
) -> int:
    if prepared_basis == measurement_basis:
        return prepared_bit
    return rng.randrange(2)


def _evenly_spaced(values: Sequence[int], limit: int) -> tuple[int, ...]:
    if len(values) <= limit:
        return tuple(values)
    if limit == 1:
        return (values[0],)
    last = len(values) - 1
    return tuple(
        values[round(position * last / (limit - 1))]
        for position in range(limit)
    )


def _select_public_trace_indices(
    qubit_count: int,
    disclosed_indices: Sequence[int],
) -> tuple[int, ...]:
    """Select bounded diagnostic rows without exposing undisclosed bit values.

    Up to half of the trace is spread across disclosed sample positions so the
    QBER evidence is visible. The rest uses the earliest undisclosed positions
    to show basis-sifting context. Rows are returned in transmission order.
    """

    disclosed_set = set(disclosed_indices)
    sampled = _evenly_spaced(
        disclosed_indices,
        min(MAX_PUBLIC_SAMPLED_TRACE_ROWS, len(disclosed_indices)),
    )
    context_budget = MAX_PUBLIC_TRACE_ROWS - len(sampled)
    context = tuple(
        index for index in range(qubit_count) if index not in disclosed_set
    )[:context_budget]
    return tuple(sorted((*sampled, *context)))


def simulate_bb84(
    config: BB84Config,
    *,
    rng: RandomSource | None = None,
) -> BB84SimulationResult:
    """Run a bounded BB84 classical simulation and return public diagnostics.

    ``noise_probability`` is a simplified independent outcome-flip model. It
    is useful for experiments but is not a physical optical-channel model.
    """

    random_source: RandomSource
    if rng is not None:
        random_source = rng
    elif config.seed is not None:
        random_source = random.Random(config.seed)
    else:
        random_source = random.SystemRandom()

    alice_bits = tuple(random_source.randrange(2) for _ in range(config.qubit_count))
    alice_bases = tuple(_random_basis(random_source) for _ in range(config.qubit_count))
    bob_bases = tuple(_random_basis(random_source) for _ in range(config.qubit_count))

    transmitted_bits = list(alice_bits)
    transmitted_bases = list(alice_bases)
    intercepted_flags = [False] * config.qubit_count
    for index in range(config.qubit_count):
        if random_source.random() < config.intercept_probability:
            intercepted_flags[index] = True
            eve_basis = _random_basis(random_source)
            transmitted_bits[index] = _measure(
                alice_bits[index], alice_bases[index], eve_basis, random_source
            )
            transmitted_bases[index] = eve_basis

    bob_bits: list[int] = []
    for index in range(config.qubit_count):
        measured_bit = _measure(
            transmitted_bits[index],
            transmitted_bases[index],
            bob_bases[index],
            random_source,
        )
        if random_source.random() < config.noise_probability:
            measured_bit ^= 1
        bob_bits.append(measured_bit)

    matched_indices = sift_indices(alice_bases, bob_bases)
    sample_size = (
        min(
            len(matched_indices),
            max(1, math.ceil(len(matched_indices) * config.sample_ratio)),
        )
        if matched_indices
        else 0
    )
    disclosed_indices = (
        tuple(sorted(random_source.sample(matched_indices, sample_size)))
        if sample_size
        else ()
    )
    disclosed_set = set(disclosed_indices)
    mismatches, qber = calculate_qber(
        alice_bits,
        bob_bits,
        disclosed_indices,
    )
    retained = len(matched_indices) - sample_size

    if not matched_indices or sample_size == 0 or retained == 0:
        decision = BB84Decision("aborted", "insufficient_sifted_bits")
    elif qber is not None and qber > config.qber_threshold:
        decision = BB84Decision("aborted", "qber_above_threshold")
    else:
        decision = BB84Decision("accepted", "qber_within_threshold")

    trace_indices = _select_public_trace_indices(
        config.qubit_count,
        disclosed_indices,
    )
    trace = tuple(
        BB84TraceRow(
            index=index,
            alice_basis=alice_bases[index],
            bob_basis=bob_bases[index],
            basis_match=alice_bases[index] == bob_bases[index],
            intercepted=intercepted_flags[index],
            sampled=index in disclosed_set,
            sample_comparison=(
                "match"
                if alice_bits[index] == bob_bits[index]
                else "mismatch"
            )
            if index in disclosed_set
            else None,
        )
        for index in trace_indices
    )

    retained_indices = tuple(
        index for index in matched_indices if index not in disclosed_set
    )

    return BB84SimulationResult(
        config=config,
        metrics=BB84Metrics(
            transmitted=config.qubit_count,
            intercepted=sum(intercepted_flags),
            sifted=len(matched_indices),
            sample=sample_size,
            mismatches=mismatches,
            qber=qber,
            retained=retained,
        ),
        decision=decision,
        trace=trace,
        _private_candidate_transcript=_PrivateCandidateTranscript(
            alice_bits=bytearray(alice_bits[index] for index in retained_indices),
            bob_bits=bytearray(bob_bits[index] for index in retained_indices),
        ),
    )
