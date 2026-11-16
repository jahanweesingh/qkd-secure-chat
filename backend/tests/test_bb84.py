from __future__ import annotations

import math
from dataclasses import asdict

import pytest
from pydantic import ValidationError

from app.bb84 import (
    MAX_SAFE_INTEGER_SEED,
    BB84Config,
    calculate_qber,
    sift_indices,
    simulate_bb84,
)
from app.schemas import BB84StartCommand


def test_sifting_and_qber_known_vector() -> None:
    alice_bases = ("Z", "X", "Z", "X", "X", "Z")
    bob_bases = ("Z", "Z", "Z", "X", "Z", "X")
    assert sift_indices(alice_bases, bob_bases) == (0, 2, 3)

    mismatches, qber = calculate_qber(
        (0, 1, 1, 0, 1, 0),
        (0, 0, 0, 0, 1, 1),
        (0, 2, 3),
    )
    assert mismatches == 1
    assert qber == pytest.approx(1 / 3)


def test_seeded_simulation_is_reproducible() -> None:
    config = BB84Config(
        qubit_count=512,
        noise_probability=0.03,
        intercept_probability=0.4,
        sample_ratio=0.25,
        qber_threshold=0.11,
        seed=20260913,
    )
    assert simulate_bb84(config) == simulate_bb84(config)


def test_ideal_channel_has_zero_sample_qber() -> None:
    result = simulate_bb84(BB84Config(qubit_count=512, seed=7))
    assert result.metrics.transmitted == 512
    assert result.metrics.intercepted == 0
    assert result.metrics.sifted > 0
    assert result.metrics.sample == math.ceil(result.metrics.sifted * 0.25)
    assert result.metrics.qber == 0.0
    assert result.metrics.retained == result.metrics.sifted - result.metrics.sample
    assert result.decision.status == "accepted"
    assert result.decision.reason == "qber_within_threshold"


def test_noise_above_policy_threshold_aborts() -> None:
    result = simulate_bb84(
        BB84Config(
            qubit_count=1024,
            noise_probability=0.25,
            sample_ratio=0.5,
            qber_threshold=0.10,
            seed=31,
        )
    )
    assert result.metrics.qber is not None
    assert result.metrics.qber > 0.10
    assert result.decision.status == "aborted"
    assert result.decision.reason == "qber_above_threshold"


def test_full_intercept_resend_approaches_expected_quarter_qber() -> None:
    result = simulate_bb84(
        BB84Config(
            qubit_count=1024,
            intercept_probability=1.0,
            sample_ratio=0.5,
            qber_threshold=0.11,
            seed=919,
        )
    )
    assert result.metrics.intercepted == 1024
    assert result.metrics.qber is not None
    assert 0.15 <= result.metrics.qber <= 0.35
    assert result.decision.status == "aborted"


def test_qber_equal_to_threshold_is_accepted() -> None:
    baseline = simulate_bb84(
        BB84Config(
            qubit_count=1024,
            noise_probability=0.1,
            sample_ratio=0.5,
            qber_threshold=0.25,
            seed=123,
        )
    )
    assert baseline.metrics.qber is not None
    assert 0.01 <= baseline.metrics.qber <= 0.25

    at_boundary = simulate_bb84(
        BB84Config(
            qubit_count=1024,
            noise_probability=0.1,
            sample_ratio=0.5,
            qber_threshold=baseline.metrics.qber,
            seed=123,
        )
    )
    assert at_boundary.metrics.qber == baseline.metrics.qber
    assert at_boundary.decision.status == "accepted"
    assert at_boundary.decision.reason == "qber_within_threshold"


def test_no_basis_matches_aborts_as_insufficient_sifted_bits() -> None:
    class NoSiftRandom:
        def __init__(self) -> None:
            self.randrange_calls = 0

        def randrange(self, stop: int) -> int:
            assert stop == 2
            call = self.randrange_calls
            self.randrange_calls += 1
            if 128 <= call < 256:
                return 0  # Alice always chooses Z.
            if 256 <= call < 384:
                return 1  # Bob always chooses X.
            return 0

        def random(self) -> float:
            return 1.0

        def sample(self, population, k):
            raise AssertionError("sampling must not run without sifted positions")

    result = simulate_bb84(BB84Config(qubit_count=128), rng=NoSiftRandom())

    assert result.metrics.sifted == 0
    assert result.metrics.sample == 0
    assert result.metrics.qber is None
    assert result.metrics.retained == 0
    assert result.decision.status == "aborted"
    assert result.decision.reason == "insufficient_sifted_bits"


def test_public_trace_is_bounded_and_never_exposes_key_bits() -> None:
    result = simulate_bb84(
        BB84Config(
            qubit_count=128,
            noise_probability=0.1,
            intercept_probability=0.5,
            sample_ratio=0.5,
            seed=11,
        )
    )
    payload = result.public_payload()
    trace = payload["trace"]
    assert isinstance(trace, list)
    assert len(trace) == 24
    assert any(row["sampled"] for row in trace)
    assert any(not row["sampled"] for row in trace)
    for row in trace:
        assert isinstance(row, dict)
        assert "alice_bit" not in row
        assert "bob_bit" not in row
        assert "prepared_bit" not in row
        if not row["sampled"]:
            assert row["sample_comparison"] is None
        else:
            assert row["sample_comparison"] in {"match", "mismatch"}


def test_javascript_safe_seed_boundary_is_shared_by_domain_and_schema() -> None:
    domain_config = BB84Config(qubit_count=128, seed=MAX_SAFE_INTEGER_SEED)
    assert domain_config.seed == 9_007_199_254_740_991
    assert simulate_bb84(domain_config) == simulate_bb84(domain_config)

    command = BB84StartCommand.model_validate(
        {"type": "bb84_start", "seed": MAX_SAFE_INTEGER_SEED}
    )
    assert command.seed == MAX_SAFE_INTEGER_SEED

    with pytest.raises(ValueError, match="seed must be between"):
        BB84Config(seed=MAX_SAFE_INTEGER_SEED + 1)
    with pytest.raises(ValidationError):
        BB84StartCommand.model_validate(
            {"type": "bb84_start", "seed": MAX_SAFE_INTEGER_SEED + 1}
        )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "type": "bb84_start",
            "qubit_count": 128,
            "noise_probability": 0,
            "intercept_probability": 0,
            "sample_ratio": 0.1,
            "qber_threshold": 0.01,
            "seed": 0,
        },
        {
            "type": "bb84_start",
            "qubit_count": 1024,
            "noise_probability": 0.25,
            "intercept_probability": 1,
            "sample_ratio": 0.5,
            "qber_threshold": 0.25,
            "seed": MAX_SAFE_INTEGER_SEED,
        },
    ],
)
def test_command_schema_accepts_inclusive_boundaries(
    payload: dict[str, object],
) -> None:
    assert BB84StartCommand.model_validate(payload).type == "bb84_start"


@pytest.mark.parametrize(
    "change",
    [
        {"qubit_count": 128.0},
        {"qubit_count": True},
        {"noise_probability": "0.1"},
        {"intercept_probability": False},
        {"sample_ratio": float("nan")},
        {"qber_threshold": 0.251},
        {"seed": 1.0},
        {"unexpected": "field"},
    ],
)
def test_command_schema_rejects_wrong_types_bounds_and_extras(
    change: dict[str, object],
) -> None:
    payload: dict[str, object] = {"type": "bb84_start"}
    payload.update(change)
    with pytest.raises(ValidationError):
        BB84StartCommand.model_validate(payload)


@pytest.mark.parametrize(
    "changes",
    [
        {"qubit_count": 129},
        {"noise_probability": 0.26},
        {"intercept_probability": -0.1},
        {"sample_ratio": 0.09},
        {"qber_threshold": 0.0},
        {"seed": True},
        {"seed": MAX_SAFE_INTEGER_SEED + 1},
        {"qubit_count": 128.0},
        {"noise_probability": "0.1"},
        {"sample_ratio": float("nan")},
    ],
)
def test_domain_config_rejects_unsupported_values(changes: dict[str, object]) -> None:
    values = asdict(BB84Config())
    values.update(changes)
    with pytest.raises(ValueError):
        BB84Config(**values)


def test_domain_helpers_reject_invalid_inputs() -> None:
    with pytest.raises(ValueError, match="equal length"):
        sift_indices(("Z",), ("Z", "X"))
    with pytest.raises(ValueError, match="only Z and X"):
        sift_indices(("Y",), ("Z",))  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="only 0 and 1"):
        calculate_qber((2,), (0,), (0,))
    with pytest.raises(ValueError, match="out of range"):
        calculate_qber((0,), (0,), (1,))
