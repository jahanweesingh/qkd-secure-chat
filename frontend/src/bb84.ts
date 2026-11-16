export const BB84_QUBIT_COUNTS = [128, 256, 512, 1024] as const;
export const MAX_BB84_TRACE_ROWS = 24;

export type Bb84QubitCount = (typeof BB84_QUBIT_COUNTS)[number];
export type Bb84Basis = 'Z' | 'X';
export type Bb84DecisionStatus = 'accepted' | 'aborted';
export type Bb84RunState = 'idle' | 'running' | 'complete' | 'error';
export type Bb84PostProcessingStatus = 'completed' | 'skipped' | 'failed';
export type Bb84PostProcessingReason =
  | 'completed'
  | 'bb84_not_accepted'
  | 'reconciliation_failed'
  | 'insufficient_entropy'
  | 'confirmation_failed'
  | 'derivation_failed';

export interface Bb84Config {
  qubitCount: Bb84QubitCount;
  noiseProbability: number;
  interceptProbability: number;
  sampleRatio: number;
  qberThreshold: number;
  seed: number | null;
}

/** Repeatable public teaching presets; the backend still computes every result. */
export function demonstrationConfig(eve: boolean): Bb84Config {
  return { qubitCount: 1024, noiseProbability: 0, interceptProbability: eve ? 1 : 0,
    sampleRatio: 0.25, qberThreshold: 0.11, seed: 7 };
}

export interface Bb84Metrics {
  transmitted: number;
  intercepted: number;
  sifted: number;
  sample: number;
  mismatches: number;
  qber: number | null;
  retained: number;
}

export interface Bb84TraceRow {
  index: number;
  aliceBasis: Bb84Basis;
  bobBasis: Bb84Basis;
  basisMatch: boolean;
  intercepted: boolean;
  sampled: boolean;
  sampleComparison: 'match' | 'mismatch' | null;
}

export interface Bb84PostProcessing {
  version: 'phase3-post-processing-v1';
  status: Bb84PostProcessingStatus;
  reason: Bb84PostProcessingReason;
  inputBits: number;
  reconciliation: {
    algorithm: 'cascade-inspired-parity-v1';
    passes: number;
    correctedErrors: number;
    remainingErrors: number;
    leakedBits: number;
    verified: boolean;
  };
  privacyAmplification: {
    algorithm: 'toeplitz-universal-hash-v1';
    entropyModel: 'illustrative-asymptotic-bb84-binary-entropy-v1';
    securityMarginBits: number;
    estimatedSecretBits: number;
    outputBits: number;
  };
  confirmation: {
    algorithm: 'hmac-sha256-truncated-v1';
    tagBits: number;
    passed: boolean;
  };
  derivation: {
    algorithm: 'hkdf-sha256-v1';
    outputBits: number;
    contextBound: boolean;
    materialRetained: false;
  };
  keyMaterialExposed: false;
  keyUsedForChat: false;
  reproducibleTeachingRun: boolean;
}

export interface Bb84Result {
  sessionId: string;
  startedBy: string;
  createdAt: string;
  simulationOnly: boolean;
  chatEncryptionActive: boolean;
  config: Bb84Config;
  metrics: Bb84Metrics;
  decision: {
    status: Bb84DecisionStatus;
    reason: 'qber_within_threshold' | 'qber_above_threshold' | 'insufficient_sifted_bits';
  };
  postProcessing: Bb84PostProcessing;
  trace: Bb84TraceRow[];
}

export interface Bb84StartCommand {
  type: 'bb84_start';
  qubit_count: Bb84QubitCount;
  noise_probability: number;
  intercept_probability: number;
  sample_ratio: number;
  qber_threshold: number;
  seed: number | null;
}

type JsonObject = Record<string, unknown>;

const FORBIDDEN_SECRET_FIELDS = new Set([
  'alice_bit',
  'alice_bits',
  'bob_bit',
  'bob_bits',
  'eve_bit',
  'eve_bits',
  'eve_measured_bits',
  'prepared_bit',
  'prepared_bits',
  'raw_bit',
  'raw_bits',
  'raw_key',
  'candidate_bit',
  'candidate_bits',
  'candidate_key',
  'retained_bit',
  'retained_bits',
  'reconciled_bit',
  'reconciled_bits',
  'reconciled_key',
  'privacy_amplified_bits',
  'privacy_amplified_material',
  'toeplitz_seed',
  'confirmation_tag',
  'confirmation_tags',
  'hmac_tag',
  'hkdf_salt',
  'derived_byte',
  'derived_bytes',
  'derived_material',
  'derived_key',
  'key_bytes',
  'key_material',
  'private_candidate_transcript',
  'secrets',
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedFieldName(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function containsForbiddenSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenSecretField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([field, nestedValue]) => (
    FORBIDDEN_SECRET_FIELDS.has(normalizedFieldName(field))
    || containsForbiddenSecretField(nestedValue)
  ));
}

function readString(source: JsonObject, key: string): string | null {
  return typeof source[key] === 'string' && source[key] ? source[key] : null;
}

function readNumber(source: JsonObject, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonNegativeInteger(source: JsonObject, key: string): number | null {
  const value = readNumber(source, key);
  return value !== null && Number.isInteger(value) && value >= 0 ? value : null;
}

function readBoolean(source: JsonObject, key: string): boolean | null {
  return typeof source[key] === 'boolean' ? source[key] : null;
}

function isProbability(value: number | null, maximum = 1): value is number {
  return value !== null && value >= 0 && value <= maximum;
}

function normalizeConfig(value: unknown): Bb84Result['config'] | null {
  if (!isObject(value)) return null;
  const qubitCount = readNonNegativeInteger(value, 'qubit_count');
  const noiseProbability = readNumber(value, 'noise_probability');
  const interceptProbability = readNumber(value, 'intercept_probability');
  const sampleRatio = readNumber(value, 'sample_ratio');
  const qberThreshold = readNumber(value, 'qber_threshold');
  const seedValue = value.seed;
  let seed: number | null;
  if (seedValue === null) {
    seed = null;
  } else if (typeof seedValue === 'number' && Number.isSafeInteger(seedValue) && seedValue >= 0) {
    seed = seedValue;
  } else {
    return null;
  }

  if (
    !BB84_QUBIT_COUNTS.includes(qubitCount as Bb84QubitCount)
    || !isProbability(noiseProbability, 0.25)
    || !isProbability(interceptProbability)
    || sampleRatio === null || sampleRatio < 0.1 || sampleRatio > 0.5
    || qberThreshold === null || qberThreshold < 0.01 || qberThreshold > 0.25
  ) return null;

  return {
    qubitCount: qubitCount as Bb84QubitCount,
    noiseProbability,
    interceptProbability,
    sampleRatio,
    qberThreshold,
    seed,
  };
}

function normalizeMetrics(value: unknown): Bb84Metrics | null {
  if (!isObject(value)) return null;
  const transmitted = readNonNegativeInteger(value, 'transmitted');
  const intercepted = readNonNegativeInteger(value, 'intercepted');
  const sifted = readNonNegativeInteger(value, 'sifted');
  const sample = readNonNegativeInteger(value, 'sample');
  const mismatches = readNonNegativeInteger(value, 'mismatches');
  const retained = readNonNegativeInteger(value, 'retained');
  const qberValue = value.qber;
  const qber = qberValue === null
    ? null
    : typeof qberValue === 'number' && Number.isFinite(qberValue) && qberValue >= 0 && qberValue <= 1
      ? qberValue
      : undefined;

  if (
    transmitted === null || intercepted === null || sifted === null
    || sample === null || mismatches === null || retained === null
    || qber === undefined
  ) return null;

  return { transmitted, intercepted, sifted, sample, mismatches, qber, retained };
}

function normalizeDecision(value: unknown): Bb84Result['decision'] | null {
  if (!isObject(value)) return null;
  const status = readString(value, 'status');
  const reason = readString(value, 'reason');
  if (status !== 'accepted' && status !== 'aborted') return null;
  if (
    reason !== 'qber_within_threshold'
    && reason !== 'qber_above_threshold'
    && reason !== 'insufficient_sifted_bits'
  ) return null;
  return { status, reason };
}

function normalizePostProcessing(value: unknown): Bb84PostProcessing | null {
  if (!isObject(value)) return null;
  const version = readString(value, 'version');
  const status = readString(value, 'status');
  const reason = readString(value, 'reason');
  const inputBits = readNonNegativeInteger(value, 'input_bits');
  if (
    (status !== 'completed' && status !== 'skipped' && status !== 'failed')
    || (
      reason !== 'completed'
      && reason !== 'bb84_not_accepted'
      && reason !== 'reconciliation_failed'
      && reason !== 'insufficient_entropy'
      && reason !== 'confirmation_failed'
      && reason !== 'derivation_failed'
    )
    || inputBits === null
    || !isObject(value.reconciliation)
    || !isObject(value.privacy_amplification)
    || !isObject(value.confirmation)
    || !isObject(value.derivation)
  ) return null;

  const reconciliation = value.reconciliation;
  const reconciliationAlgorithm = readString(reconciliation, 'algorithm');
  const passes = readNonNegativeInteger(reconciliation, 'passes');
  const correctedErrors = readNonNegativeInteger(reconciliation, 'corrected_errors');
  const remainingErrors = readNonNegativeInteger(reconciliation, 'remaining_errors');
  const leakedBits = readNonNegativeInteger(reconciliation, 'leaked_bits');
  const verified = readBoolean(reconciliation, 'verified');

  const privacyAmplification = value.privacy_amplification;
  const privacyAlgorithm = readString(privacyAmplification, 'algorithm');
  const entropyModel = readString(privacyAmplification, 'entropy_model');
  const securityMarginBits = readNonNegativeInteger(privacyAmplification, 'security_margin_bits');
  const estimatedSecretBits = readNonNegativeInteger(privacyAmplification, 'estimated_secret_bits');
  const privacyOutputBits = readNonNegativeInteger(privacyAmplification, 'output_bits');

  const confirmation = value.confirmation;
  const confirmationAlgorithm = readString(confirmation, 'algorithm');
  const tagBits = readNonNegativeInteger(confirmation, 'tag_bits');
  const confirmationPassed = readBoolean(confirmation, 'passed');

  const derivation = value.derivation;
  const derivationAlgorithm = readString(derivation, 'algorithm');
  const derivationOutputBits = readNonNegativeInteger(derivation, 'output_bits');
  const contextBound = readBoolean(derivation, 'context_bound');
  const materialRetained = readBoolean(derivation, 'material_retained');
  const reproducibleTeachingRun = readBoolean(value, 'reproducible_teaching_run');

  if (
    version !== 'phase3-post-processing-v1'
    || reconciliationAlgorithm !== 'cascade-inspired-parity-v1'
    || passes === null || passes > 8 || correctedErrors === null
    || remainingErrors === null || leakedBits === null || verified === null
    || privacyAlgorithm !== 'toeplitz-universal-hash-v1'
    || entropyModel !== 'illustrative-asymptotic-bb84-binary-entropy-v1'
    || securityMarginBits !== 32
    || estimatedSecretBits === null || privacyOutputBits === null
    || confirmationAlgorithm !== 'hmac-sha256-truncated-v1'
    || tagBits !== 128 || confirmationPassed === null
    || derivationAlgorithm !== 'hkdf-sha256-v1' || derivationOutputBits === null
    || contextBound === null || materialRetained === null
    || reproducibleTeachingRun === null
    || value.key_material_exposed !== false
    || value.key_used_for_chat !== false
    || inputBits > 1024
    || correctedErrors > inputBits * 8
    || remainingErrors > inputBits
    || leakedBits > 65_536
    || estimatedSecretBits > inputBits
    || privacyOutputBits > estimatedSecretBits
    || materialRetained
    || (status === 'completed' && reason !== 'completed')
    || (status === 'skipped' && reason !== 'bb84_not_accepted')
    || (status === 'failed' && ![
      'reconciliation_failed',
      'insufficient_entropy',
      'confirmation_failed',
      'derivation_failed',
    ].includes(reason))
    || (status === 'completed' && (
      !verified || remainingErrors !== 0 || estimatedSecretBits < 128
      || privacyOutputBits !== 128 || !confirmationPassed
      || derivationOutputBits !== 256 || !contextBound
    ))
    || (status === 'skipped' && (
      passes !== 0 || correctedErrors !== 0 || remainingErrors !== 0 || leakedBits !== 0
      || verified || estimatedSecretBits !== 0 || privacyOutputBits !== 0
      || confirmationPassed || derivationOutputBits !== 0 || contextBound
    ))
    || (status === 'failed' && (derivationOutputBits !== 0 || contextBound))
    || (reason === 'reconciliation_failed' && (
      verified || estimatedSecretBits !== 0 || privacyOutputBits !== 0 || confirmationPassed
    ))
    || (reason === 'insufficient_entropy' && (
      !verified || remainingErrors !== 0 || estimatedSecretBits >= 128
      || privacyOutputBits !== 0 || confirmationPassed
    ))
    || (reason === 'confirmation_failed' && (
      !verified || remainingErrors !== 0 || estimatedSecretBits < 128
      || privacyOutputBits !== 128 || confirmationPassed
    ))
    || (reason === 'derivation_failed' && (
      !verified || remainingErrors !== 0 || estimatedSecretBits < 128
      || privacyOutputBits !== 128 || !confirmationPassed
    ))
  ) return null;

  return {
    version,
    status,
    reason,
    inputBits,
    reconciliation: {
      algorithm: reconciliationAlgorithm,
      passes,
      correctedErrors,
      remainingErrors,
      leakedBits,
      verified,
    },
    privacyAmplification: {
      algorithm: privacyAlgorithm,
      entropyModel,
      securityMarginBits,
      estimatedSecretBits,
      outputBits: privacyOutputBits,
    },
    confirmation: {
      algorithm: confirmationAlgorithm,
      tagBits,
      passed: confirmationPassed,
    },
    derivation: {
      algorithm: derivationAlgorithm,
      outputBits: derivationOutputBits,
      contextBound,
      materialRetained,
    },
    keyMaterialExposed: value.key_material_exposed,
    keyUsedForChat: value.key_used_for_chat,
    reproducibleTeachingRun,
  };
}

function normalizeTraceRow(value: unknown): Bb84TraceRow | null {
  if (!isObject(value)) return null;
  const index = readNonNegativeInteger(value, 'index');
  const aliceBasis = readString(value, 'alice_basis');
  const bobBasis = readString(value, 'bob_basis');
  const sampleComparison = value.sample_comparison;
  if (
    index === null
    || (aliceBasis !== 'Z' && aliceBasis !== 'X')
    || (bobBasis !== 'Z' && bobBasis !== 'X')
    || typeof value.basis_match !== 'boolean'
    || typeof value.intercepted !== 'boolean'
    || typeof value.sampled !== 'boolean'
    || (sampleComparison !== null && sampleComparison !== 'match' && sampleComparison !== 'mismatch')
    || (value.sampled && sampleComparison === null)
    || (!value.sampled && sampleComparison !== null)
    || value.basis_match !== (aliceBasis === bobBasis)
    || (value.sampled && !value.basis_match)
  ) return null;
  return {
    index,
    aliceBasis,
    bobBasis,
    basisMatch: value.basis_match,
    intercepted: value.intercepted,
    sampled: value.sampled,
    sampleComparison,
  };
}

export function normalizeBb84Result(value: unknown): Bb84Result | null {
  if (
    !isObject(value)
    || value.type !== 'bb84_result'
    || containsForbiddenSecretField(value)
  ) return null;
  const sessionId = readString(value, 'session_id');
  const startedBy = readString(value, 'started_by');
  const createdAt = readString(value, 'created_at');
  const config = normalizeConfig(value.config);
  const metrics = normalizeMetrics(value.metrics);
  const decision = normalizeDecision(value.decision);
  const postProcessing = normalizePostProcessing(value.post_processing);
  if (
    !sessionId || !startedBy || !createdAt || !config || !metrics || !decision || !postProcessing
    || value.simulation_only !== true
    || value.chat_encryption_active !== false
    || !Array.isArray(value.trace)
  ) return null;

  const expectedQber = metrics.sample > 0 ? metrics.mismatches / metrics.sample : null;
  if (
    metrics.transmitted !== config.qubitCount
    || metrics.intercepted > metrics.transmitted
    || metrics.sifted > metrics.transmitted
    || metrics.sample > metrics.sifted
    || metrics.mismatches > metrics.sample
    || metrics.retained !== metrics.sifted - metrics.sample
    || (expectedQber === null
      ? metrics.qber !== null
      : metrics.qber === null || Math.abs(metrics.qber - expectedQber) > 1e-12)
    || (decision.status === 'accepted' && decision.reason !== 'qber_within_threshold')
    || (decision.status === 'aborted' && decision.reason === 'qber_within_threshold')
    || (decision.reason === 'qber_within_threshold'
      && (metrics.qber === null || metrics.qber > config.qberThreshold || metrics.retained === 0))
    || (decision.reason === 'qber_above_threshold'
      && (metrics.qber === null || metrics.qber <= config.qberThreshold))
    || (decision.reason === 'insufficient_sifted_bits'
      && metrics.sifted > 0 && metrics.sample > 0 && metrics.retained > 0)
    || postProcessing.inputBits !== metrics.retained
    || (decision.status === 'aborted'
      && (postProcessing.status !== 'skipped' || postProcessing.reason !== 'bb84_not_accepted'))
    || (decision.status === 'accepted' && postProcessing.status === 'skipped')
    || postProcessing.reproducibleTeachingRun !== (config.seed !== null)
  ) return null;

  const traceRows = value.trace
    .slice(0, MAX_BB84_TRACE_ROWS)
    .map(normalizeTraceRow);
  if (traceRows.some((row) => row === null)) return null;
  const trace = traceRows.filter((row): row is Bb84TraceRow => row !== null);
  if (
    trace.some((row) => row.index >= metrics.transmitted)
    || new Set(trace.map((row) => row.index)).size !== trace.length
  ) return null;

  return {
    sessionId,
    startedBy,
    createdAt,
    simulationOnly: value.simulation_only,
    chatEncryptionActive: value.chat_encryption_active,
    config,
    metrics,
    decision,
    postProcessing,
    trace,
  };
}

export function createBb84StartCommand(config: Bb84Config): Bb84StartCommand {
  return {
    type: 'bb84_start',
    qubit_count: config.qubitCount,
    noise_probability: config.noiseProbability,
    intercept_probability: config.interceptProbability,
    sample_ratio: config.sampleRatio,
    qber_threshold: config.qberThreshold,
    seed: config.seed,
  };
}
