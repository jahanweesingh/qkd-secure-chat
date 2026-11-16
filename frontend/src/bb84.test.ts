import { describe, expect, it } from 'vitest';
import {
  createBb84StartCommand,
  MAX_BB84_TRACE_ROWS,
  normalizeBb84Result,
} from './bb84';

function resultPayload(traceLength = 1) {
  return {
    type: 'bb84_result',
    session_id: 'sim_0123456789abcdef01234567',
    started_by: 'client-alice',
    created_at: '2026-09-13T12:00:00Z',
    simulation_only: true,
    chat_encryption_active: false,
    config: {
      qubit_count: 1024,
      noise_probability: 0.02,
      intercept_probability: 0.25,
      sample_ratio: 0.25,
      qber_threshold: 0.11,
      seed: null,
    },
    metrics: {
      transmitted: 1024,
      intercepted: 123,
      sifted: 500,
      sample: 125,
      mismatches: 5,
      qber: 5 / 125,
      retained: 375,
    },
    decision: { status: 'accepted', reason: 'qber_within_threshold' },
    post_processing: {
      version: 'phase3-post-processing-v1',
      status: 'completed',
      reason: 'completed',
      input_bits: 375,
      reconciliation: {
        algorithm: 'cascade-inspired-parity-v1',
        passes: 6,
        corrected_errors: 2,
        remaining_errors: 0,
        leaked_bits: 18,
        verified: true,
      },
      privacy_amplification: {
        algorithm: 'toeplitz-universal-hash-v1',
        entropy_model: 'illustrative-asymptotic-bb84-binary-entropy-v1',
        security_margin_bits: 32,
        estimated_secret_bits: 280,
        output_bits: 128,
      },
      confirmation: {
        algorithm: 'hmac-sha256-truncated-v1',
        tag_bits: 128,
        passed: true,
      },
      derivation: {
        algorithm: 'hkdf-sha256-v1',
        output_bits: 256,
        context_bound: true,
        material_retained: false,
      },
      key_material_exposed: false,
      key_used_for_chat: false,
      reproducible_teaching_run: false,
    },
    trace: Array.from({ length: traceLength }, (_, index) => {
      const aliceBasis = index % 2 ? 'X' : 'Z';
      const basisMatch = index % 3 !== 1;
      const sampled = basisMatch && index % 5 === 0;
      return {
        index,
        alice_basis: aliceBasis,
        bob_basis: basisMatch ? aliceBasis : aliceBasis === 'Z' ? 'X' : 'Z',
        basis_match: basisMatch,
        intercepted: index % 4 === 0,
        sampled,
        sample_comparison: sampled ? 'match' : null,
      };
    }),
  };
}

describe('BB84 WebSocket protocol helpers', () => {
  it('serializes the exact validated start command', () => {
    expect(createBb84StartCommand({
      qubitCount: 256,
      noiseProbability: 0.03,
      interceptProbability: 0.5,
      sampleRatio: 0.3,
      qberThreshold: 0.12,
      seed: null,
    })).toEqual({
      type: 'bb84_start',
      qubit_count: 256,
      noise_probability: 0.03,
      intercept_probability: 0.5,
      sample_ratio: 0.3,
      qber_threshold: 0.12,
      seed: null,
    });
  });

  it('normalizes the server snake_case result without exposing key bits', () => {
    expect(normalizeBb84Result(resultPayload())).toMatchObject({
      sessionId: 'sim_0123456789abcdef01234567',
      startedBy: 'client-alice',
      simulationOnly: true,
      chatEncryptionActive: false,
      config: { qubitCount: 1024, noiseProbability: 0.02 },
      metrics: { sample: 125, mismatches: 5, retained: 375 },
      decision: { status: 'accepted', reason: 'qber_within_threshold' },
      postProcessing: {
        status: 'completed',
        inputBits: 375,
        reconciliation: { verified: true, leakedBits: 18 },
        privacyAmplification: { estimatedSecretBits: 280, outputBits: 128 },
        confirmation: { passed: true },
        derivation: { outputBits: 256, materialRetained: false },
        keyMaterialExposed: false,
        keyUsedForChat: false,
        reproducibleTeachingRun: false,
      },
      trace: [{ index: 0, aliceBasis: 'Z', bobBasis: 'Z', sampled: true }],
    });
  });

  it('keeps the educational trace bounded', () => {
    const result = normalizeBb84Result(resultPayload(MAX_BB84_TRACE_ROWS + 12));
    expect(result?.trace).toHaveLength(MAX_BB84_TRACE_ROWS);
    expect(result?.trace.at(-1)?.index).toBe(MAX_BB84_TRACE_ROWS - 1);
  });

  it('rejects malformed or misleading result envelopes', () => {
    expect(normalizeBb84Result({ ...resultPayload(), simulation_only: 'yes' })).toBeNull();
    expect(normalizeBb84Result({ ...resultPayload(), chat_encryption_active: 'no' })).toBeNull();
    expect(normalizeBb84Result({ ...resultPayload(), simulation_only: false })).toBeNull();
    expect(normalizeBb84Result({ ...resultPayload(), chat_encryption_active: true })).toBeNull();
    expect(normalizeBb84Result({
      ...resultPayload(),
      post_processing: { ...resultPayload().post_processing, key_material_exposed: true },
    })).toBeNull();
    expect(normalizeBb84Result({
      ...resultPayload(),
      post_processing: { ...resultPayload().post_processing, key_used_for_chat: true },
    })).toBeNull();
    expect(normalizeBb84Result({
      ...resultPayload(),
      post_processing: { ...resultPayload().post_processing, version: 'phase3-post-processing-v2' },
    })).toBeNull();
    expect(normalizeBb84Result({
      ...resultPayload(),
      post_processing: {
        ...resultPayload().post_processing,
        privacy_amplification: {
          ...resultPayload().post_processing.privacy_amplification,
          algorithm: 'unknown-hash',
        },
      },
    })).toBeNull();
    expect(normalizeBb84Result({ ...resultPayload(), post_processing: null })).toBeNull();
    expect(normalizeBb84Result({ ...resultPayload(), metrics: { qber: 2 } })).toBeNull();
  });

  it('accepts an honest skipped post-processing result after BB84 aborts', () => {
    const payload = resultPayload();
    payload.config.noise_probability = 0.2;
    payload.metrics.mismatches = 30;
    payload.metrics.qber = 30 / 125;
    payload.decision = { status: 'aborted', reason: 'qber_above_threshold' };
    payload.post_processing = {
      version: 'phase3-post-processing-v1',
      status: 'skipped',
      reason: 'bb84_not_accepted',
      input_bits: 375,
      reconciliation: {
        algorithm: 'cascade-inspired-parity-v1',
        passes: 0,
        corrected_errors: 0,
        remaining_errors: 0,
        leaked_bits: 0,
        verified: false,
      },
      privacy_amplification: {
        algorithm: 'toeplitz-universal-hash-v1',
        entropy_model: 'illustrative-asymptotic-bb84-binary-entropy-v1',
        security_margin_bits: 32,
        estimated_secret_bits: 0,
        output_bits: 0,
      },
      confirmation: {
        algorithm: 'hmac-sha256-truncated-v1',
        tag_bits: 128,
        passed: false,
      },
      derivation: {
        algorithm: 'hkdf-sha256-v1',
        output_bits: 0,
        context_bound: false,
        material_retained: false,
      },
      key_material_exposed: false,
      key_used_for_chat: false,
      reproducible_teaching_run: false,
    };

    expect(normalizeBb84Result(payload)?.postProcessing).toMatchObject({
      status: 'skipped',
      reason: 'bb84_not_accepted',
    });
  });

  it('accepts an insufficient-entropy failure without pretending to derive material', () => {
    const payload = resultPayload();
    payload.post_processing = {
      ...payload.post_processing,
      status: 'failed',
      reason: 'insufficient_entropy',
      privacy_amplification: {
        ...payload.post_processing.privacy_amplification,
        estimated_secret_bits: 20,
        output_bits: 0,
      },
      confirmation: {
        ...payload.post_processing.confirmation,
        passed: false,
      },
      derivation: {
        ...payload.post_processing.derivation,
        output_bits: 0,
        context_bound: false,
      },
    };

    expect(normalizeBb84Result(payload)?.postProcessing).toMatchObject({
      status: 'failed',
      reason: 'insufficient_entropy',
      privacyAmplification: { outputBits: 0 },
      derivation: { outputBits: 0, materialRetained: false },
    });
  });

  it('accepts safe reconciliation, confirmation, and derivation failures', () => {
    const reconciliationFailure = resultPayload();
    reconciliationFailure.post_processing = {
      ...reconciliationFailure.post_processing,
      status: 'failed',
      reason: 'reconciliation_failed',
      reconciliation: {
        ...reconciliationFailure.post_processing.reconciliation,
        remaining_errors: 1,
        verified: false,
      },
      privacy_amplification: {
        ...reconciliationFailure.post_processing.privacy_amplification,
        estimated_secret_bits: 0,
        output_bits: 0,
      },
      confirmation: {
        ...reconciliationFailure.post_processing.confirmation,
        passed: false,
      },
      derivation: {
        ...reconciliationFailure.post_processing.derivation,
        output_bits: 0,
        context_bound: false,
      },
    };
    expect(normalizeBb84Result(reconciliationFailure)?.postProcessing).toMatchObject({
      status: 'failed',
      reason: 'reconciliation_failed',
      reconciliation: { verified: false, remainingErrors: 1 },
      privacyAmplification: { estimatedSecretBits: 0, outputBits: 0 },
      derivation: { outputBits: 0, contextBound: false },
    });

    const confirmationFailure = resultPayload();
    confirmationFailure.post_processing = {
      ...confirmationFailure.post_processing,
      status: 'failed',
      reason: 'confirmation_failed',
      confirmation: {
        ...confirmationFailure.post_processing.confirmation,
        passed: false,
      },
      derivation: {
        ...confirmationFailure.post_processing.derivation,
        output_bits: 0,
        context_bound: false,
      },
    };
    expect(normalizeBb84Result(confirmationFailure)?.postProcessing).toMatchObject({
      status: 'failed',
      reason: 'confirmation_failed',
      privacyAmplification: { estimatedSecretBits: 280, outputBits: 128 },
      confirmation: { passed: false },
      derivation: { outputBits: 0, contextBound: false },
    });

    const derivationFailure = resultPayload();
    derivationFailure.post_processing = {
      ...derivationFailure.post_processing,
      status: 'failed',
      reason: 'derivation_failed',
      derivation: {
        ...derivationFailure.post_processing.derivation,
        output_bits: 0,
        context_bound: false,
      },
    };
    expect(normalizeBb84Result(derivationFailure)?.postProcessing).toMatchObject({
      status: 'failed',
      reason: 'derivation_failed',
      confirmation: { passed: true },
      derivation: { outputBits: 0, contextBound: false },
    });
  });

  it('rejects trace rows that violate the public-sample invariants', () => {
    const payload = resultPayload();
    payload.trace[0].sampled = false;
    expect(normalizeBb84Result(payload)).toBeNull();
  });

  it('rejects envelopes containing forbidden secret-like fields at any depth', () => {
    const payload = resultPayload();
    expect(normalizeBb84Result({
      ...payload,
      alice_bits: [0, 1],
      retained_bits: [1, 0],
      derived_material: 'must-not-be-visible',
    })).toBeNull();

    expect(normalizeBb84Result({
      ...payload,
      post_processing: {
        ...payload.post_processing,
        derived_material: 'also-must-not-be-visible',
      },
    })).toBeNull();

    expect(normalizeBb84Result({
      ...payload,
      trace: payload.trace.map((row) => ({
        ...row,
        alice_bit: 0,
        bob_bit: 1,
        prepared_bit: 0,
      })),
    })).toBeNull();
  });
});
