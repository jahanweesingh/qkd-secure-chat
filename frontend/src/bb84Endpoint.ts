/**
 * Browser-only BB84 classroom simulation. Inputs and derived bit material are
 * local endpoint state and must never be serialized to logs or backend events.
 * This models classical data, not quantum states or physical QKD.
 */

export const ENDPOINT_BB84_VERSION = 'bb84-endpoint-v1' as const;
export const ENDPOINT_BB84_QUBITS = 1_024;
export const ENDPOINT_BB84_BATCH_SIZE = 64;
export const ENDPOINT_BB84_OUTPUT_BITS = 128;

export type EndpointBasis = 0 | 1; // 0 = Z, 1 = X
export type EndpointRole = 'alice' | 'bob';

export interface EndpointBb84Config {
  noisePpm: number;
  interceptPpm: number;
}

export interface AlicePreparedStates {
  bits: Uint8Array;
  bases: Uint8Array;
}

export interface BobMeasuredStates {
  bases: Uint8Array;
  outcomes: Uint8Array;
  intercepted: Uint8Array;
}

export interface SiftedCandidate {
  indices: Uint16Array;
  bits: Uint8Array;
}

export interface ParityQuery {
  queryId: number;
  blockIndex: number;
  start: number;
  length: number;
  aliceParity: 0 | 1;
}

export interface ParityReply {
  queryId: number;
  parityDiffers: boolean;
}

export interface ReconcileFlip {
  queryId: number;
  position: number;
}

export type RandomBytes = (length: number) => Uint8Array;

const encoder = new TextEncoder();

function secureRandomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > 65_536) {
    throw new Error('Random byte request is outside the supported bound.');
  }
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('Web Crypto randomness is unavailable.');
  }
  const result = new Uint8Array(length);
  for (let offset = 0; offset < result.length; offset += 65_536) {
    crypto.getRandomValues(result.subarray(offset, Math.min(offset + 65_536, result.length)));
  }
  return result;
}

function randomUint32(randomBytes: RandomBytes): number {
  const value = randomBytes(4);
  if (value.length !== 4) throw new Error('Random source returned the wrong length.');
  return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, false);
}

function randomIndex(maxExclusive: number, randomBytes: RandomBytes): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x1_0000_0000) {
    throw new Error('Random range is invalid.');
  }
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  let sample = randomUint32(randomBytes);
  while (sample >= limit) sample = randomUint32(randomBytes);
  return sample % maxExclusive;
}

function probabilityPpm(value: number, name: string, max = 1_000_000): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer from 0 to ${max}.`);
  }
}

function flipWithProbability(ppm: number, randomBytes: RandomBytes): boolean {
  if (ppm === 0) return false;
  if (ppm === 1_000_000) return true;
  return randomIndex(1_000_000, randomBytes) < ppm;
}

function randomBit(randomBytes: RandomBytes): 0 | 1 {
  return randomIndex(2, randomBytes) as 0 | 1;
}

/** Alice independently creates random preparation bits and Z/X bases. */
export function generateAlicePreparedStates(
  randomBytes: RandomBytes = secureRandomBytes,
): AlicePreparedStates {
  const bits = new Uint8Array(ENDPOINT_BB84_QUBITS);
  const bases = new Uint8Array(ENDPOINT_BB84_QUBITS);
  for (let index = 0; index < ENDPOINT_BB84_QUBITS; index += 1) {
    bits[index] = randomBit(randomBytes);
    bases[index] = randomBit(randomBytes);
  }
  return { bits, bases };
}

/**
 * Bob independently chooses measurement bases and computes the software
 * measurement. The transmitted basis/bit pair is classical and inspectable.
 */
export function measureAtBob(
  alice: AlicePreparedStates,
  config: EndpointBb84Config,
  randomBytes: RandomBytes = secureRandomBytes,
): BobMeasuredStates {
  validateAlicePreparedStates(alice);
  probabilityPpm(config.noisePpm, 'noisePpm', 250_000);
  probabilityPpm(config.interceptPpm, 'interceptPpm');
  const bases = new Uint8Array(ENDPOINT_BB84_QUBITS);
  const outcomes = new Uint8Array(ENDPOINT_BB84_QUBITS);
  const intercepted = new Uint8Array(ENDPOINT_BB84_QUBITS);

  for (let index = 0; index < ENDPOINT_BB84_QUBITS; index += 1) {
    const bobBasis = randomBit(randomBytes);
    bases[index] = bobBasis;
    let transmittedBasis = alice.bases[index] as EndpointBasis;
    let transmittedBit = alice.bits[index] as 0 | 1;
    const wasIntercepted = flipWithProbability(config.interceptPpm, randomBytes);
    intercepted[index] = wasIntercepted ? 1 : 0;

    if (wasIntercepted) {
      const eveBasis = randomBit(randomBytes);
      const eveBit = eveBasis === transmittedBasis ? transmittedBit : randomBit(randomBytes);
      transmittedBasis = eveBasis;
      transmittedBit = eveBit;
    }

    let outcome = bobBasis === transmittedBasis ? transmittedBit : randomBit(randomBytes);
    if (flipWithProbability(config.noisePpm, randomBytes)) outcome = outcome === 0 ? 1 : 0;
    outcomes[index] = outcome;
  }

  return { bases, outcomes, intercepted };
}

/** Each browser constructs its candidate from its own local role data. */
export function siftLocalCandidate(
  role: EndpointRole,
  alice: AlicePreparedStates,
  bob: BobMeasuredStates,
): SiftedCandidate {
  validateAlicePreparedStates(alice);
  validateBobMeasuredStates(bob);
  const indices: number[] = [];
  const bits: number[] = [];
  for (let index = 0; index < ENDPOINT_BB84_QUBITS; index += 1) {
    if (alice.bases[index] !== bob.bases[index]) continue;
    indices.push(index);
    bits.push(role === 'alice' ? alice.bits[index] : bob.outcomes[index]);
  }
  return { indices: Uint16Array.from(indices), bits: Uint8Array.from(bits) };
}

export function sampleCommitmentInput(
  runId: Uint8Array,
  role: EndpointRole,
  seed: Uint8Array,
): Uint8Array {
  if (runId.length !== 16 || seed.length !== 32) {
    throw new Error('A 16-byte run ID and 32-byte sample seed are required.');
  }
  const roleByte = new Uint8Array([role === 'alice' ? 0 : 1]);
  return concatBytes(encoder.encode(`${ENDPOINT_BB84_VERSION}/sample-commit\0`), runId, roleByte, seed);
}

export async function createSampleCommitment(
  runId: Uint8Array,
  role: EndpointRole,
  seed: Uint8Array,
): Promise<Uint8Array> {
  return sha256(sampleCommitmentInput(runId, role, seed));
}

/** Jointly derive a deterministic, without-replacement sample after both reveals. */
export async function deriveSampleIndices(
  runId: Uint8Array,
  aliceSeed: Uint8Array,
  bobSeed: Uint8Array,
  aliceBases: Uint8Array,
  bobBases: Uint8Array,
): Promise<Uint16Array> {
  if (runId.length !== 16 || aliceSeed.length !== 32 || bobSeed.length !== 32) {
    throw new Error('Sample derivation context has an invalid length.');
  }
  validateBases(aliceBases, 'Alice bases');
  validateBases(bobBases, 'Bob bases');
  const sifted = matchingBasisIndices(aliceBases, bobBases);
  const sampleCount = Math.floor(sifted.length / 4);
  if (sampleCount < 32) throw new Error('At least 32 sifted sample bits are required.');

  const basisTranscript = await sha256(concatBytes(
    encoder.encode(`${ENDPOINT_BB84_VERSION}/bases\0`),
    runId,
    packBits(aliceBases),
    packBits(bobBases),
  ));
  const seed = await sha256(concatBytes(
    encoder.encode(`${ENDPOINT_BB84_VERSION}/sample-rank\0`),
    runId,
    aliceSeed,
    bobSeed,
    basisTranscript,
  ));
  const ranked = await Promise.all(sifted.map(async (index) => ({
    index,
    rank: await sha256(concatBytes(seed, u32be(index))),
  })));
  ranked.sort((left, right) => compareBytes(left.rank, right.rank) || left.index - right.index);
  return Uint16Array.from(ranked.slice(0, sampleCount).map((item) => item.index).sort((a, b) => a - b));
}

export function discloseSample(candidate: SiftedCandidate, siftedSampleIndices: Uint16Array): Uint8Array {
  const byIndex = new Map<number, number>();
  for (let index = 0; index < candidate.indices.length; index += 1) {
    byIndex.set(candidate.indices[index], candidate.bits[index]);
  }
  return Uint8Array.from(siftedSampleIndices.map((index) => {
    const bit = byIndex.get(index);
    if (bit === undefined) throw new Error('Sample index is not in this local candidate.');
    return bit;
  }));
}

export function calculateSampleQber(aliceValues: Uint8Array, bobValues: Uint8Array): {
  mismatches: number;
  qberPpm: number;
} {
  if (aliceValues.length !== bobValues.length || aliceValues.length < 32) {
    throw new Error('Sample vectors must match and contain at least 32 bits.');
  }
  let mismatches = 0;
  for (let index = 0; index < aliceValues.length; index += 1) {
    if (aliceValues[index] > 1 || bobValues[index] > 1) throw new Error('Sample contains a non-bit value.');
    if (aliceValues[index] !== bobValues[index]) mismatches += 1;
  }
  return { mismatches, qberPpm: Math.floor((1_000_000 * mismatches) / aliceValues.length) };
}

/** Alice's endpoint owns the parity-query state, but not Bob's candidate bits. */
export class AliceReconciliation {
  private blockStart = 0;
  private blockIndex = 0;
  private nextQueryId = 0;
  private current: ParityQuery | null = null;
  private currentIsInitial = false;
  private searchStart = 0;
  private searchLength = 0;
  private waitingForReply = false;
  private finished = false;
  private leakedBits = 0;

  constructor(private readonly aliceBits: Uint8Array) {
    validateBits(aliceBits, 'Alice retained bits');
    if (aliceBits.length > 768) throw new Error('Retained candidate exceeds the supported limit.');
  }

  get leakageBits(): number { return this.leakedBits; }
  get queryCount(): number { return this.nextQueryId; }

  nextQuery(): ParityQuery | null {
    if (this.waitingForReply) throw new Error('The previous parity query is still pending.');
    if (this.finished) return null;
    if (!this.current) {
      if (this.blockStart >= this.aliceBits.length) {
        this.finished = true;
        return null;
      }
      const blockLength = Math.min(16, this.aliceBits.length - this.blockStart);
      if (this.searchLength === 0) {
        this.searchStart = this.blockStart;
        this.searchLength = blockLength;
        this.currentIsInitial = true;
        this.current = {
          queryId: this.nextQueryId,
          blockIndex: this.blockIndex,
          start: this.blockStart,
          length: blockLength,
          aliceParity: parity(this.aliceBits, this.blockStart, blockLength),
        };
      } else {
        const leftLength = Math.floor(this.searchLength / 2);
        this.currentIsInitial = false;
        this.current = {
          queryId: this.nextQueryId,
          blockIndex: this.blockIndex,
          start: this.searchStart,
          length: leftLength,
          aliceParity: parity(this.aliceBits, this.searchStart, leftLength),
        };
      }
    }
    if (this.nextQueryId >= 512) throw new Error('Reconciliation query limit exceeded.');
    const query = { ...this.current, queryId: this.nextQueryId };
    this.nextQueryId += 1;
    this.leakedBits += 2;
    this.waitingForReply = true;
    return query;
  }

  acceptReply(reply: ParityReply): ReconcileFlip | null {
    if (!this.current || !this.waitingForReply || reply.queryId !== this.current.queryId
      && reply.queryId !== this.nextQueryId - 1) {
      throw new Error('Parity reply does not match the pending query.');
    }
    this.waitingForReply = false;
    const query = this.current;
    if (this.currentIsInitial) {
      if (!reply.parityDiffers) {
        this.advanceBlock();
        return null;
      }
      if (query.length === 1) {
        this.advanceBlock();
        return { queryId: reply.queryId, position: query.start };
      }
      this.searchStart = query.start;
      this.searchLength = query.length;
      this.current = null;
      return null;
    }
    const parentStart = this.searchStart;
    const parentLength = this.searchLength;
    const leftLength = Math.floor(parentLength / 2);
    this.searchStart = reply.parityDiffers ? parentStart : parentStart + leftLength;
    this.searchLength = reply.parityDiffers ? leftLength : parentLength - leftLength;
    if (this.searchLength === 1) {
      const flip = { queryId: reply.queryId, position: this.searchStart };
      this.advanceBlock();
      return flip;
    }
    this.current = null;
    return null;
  }

  private advanceBlock(): void {
    this.blockStart += Math.min(16, this.aliceBits.length - this.blockStart);
    this.blockIndex += 1;
    this.searchLength = 0;
    this.current = null;
  }
}

export function answerParityQuery(bobBits: Uint8Array, query: ParityQuery): ParityReply {
  validateBits(bobBits, 'Bob retained bits');
  if (query.start + query.length > bobBits.length || query.length < 1 || query.length > 16) {
    throw new Error('Parity query range is invalid.');
  }
  return {
    queryId: query.queryId,
    parityDiffers: parity(bobBits, query.start, query.length) !== query.aliceParity,
  };
}

export function applyReconciliationFlip(bobBits: Uint8Array, flip: ReconcileFlip): void {
  if (!Number.isInteger(flip.position) || flip.position < 0 || flip.position >= bobBits.length) {
    throw new Error('Reconciliation flip position is invalid.');
  }
  bobBits[flip.position] ^= 1;
}

export function estimateEducationalSecretBits(inputBits: number, leakedBits: number, qberPpm: number): number {
  if (![inputBits, leakedBits, qberPpm].every(Number.isInteger)
    || inputBits < 0 || inputBits > 768 || leakedBits < 0 || leakedBits > 1024
    || qberPpm < 0 || qberPpm > 1_000_000) {
    throw new Error('Entropy estimate inputs are outside the supported bounds.');
  }
  const qber = Math.min(qberPpm / 1_000_000, 0.5);
  const binaryEntropy = qber === 0 ? 0 : -qber * Math.log2(qber) - (1 - qber) * Math.log2(1 - qber);
  return Math.max(0, Math.floor(inputBits * (1 - binaryEntropy) - leakedBits - 32));
}

/** Apply a public Toeplitz seed to one endpoint's reconciled candidate. */
export function toeplitzPrivacyAmplify(
  inputBits: Uint8Array,
  seedBits: Uint8Array,
): Uint8Array {
  validateBits(inputBits, 'Privacy amplification input');
  if (inputBits.length < 1 || inputBits.length > 768 || seedBits.length !== inputBits.length + 127) {
    throw new Error('Toeplitz dimensions are invalid.');
  }
  validateBits(seedBits, 'Toeplitz seed');
  const output = new Uint8Array(ENDPOINT_BB84_OUTPUT_BITS);
  for (let row = 0; row < output.length; row += 1) {
    let bit = 0;
    for (let column = 0; column < inputBits.length; column += 1) {
      bit ^= seedBits[row + inputBits.length - 1 - column] & inputBits[column];
    }
    output[row] = bit;
  }
  return output;
}

export function createToeplitzSeed(inputBits: number, randomBytes: RandomBytes = secureRandomBytes): Uint8Array {
  if (!Number.isInteger(inputBits) || inputBits < 1 || inputBits > 768) {
    throw new Error('Toeplitz input length is outside the supported bound.');
  }
  const bytes = randomBytes(Math.ceil((inputBits + 127) / 8));
  if (bytes.length !== Math.ceil((inputBits + 127) / 8)) throw new Error('Random source returned the wrong length.');
  const remainder = (inputBits + 127) % 8;
  if (remainder !== 0) bytes[bytes.length - 1] &= 0xff << (8 - remainder);
  return unpackBits(bytes, inputBits + 127);
}

export function packBits(bits: Uint8Array): Uint8Array {
  validateBits(bits, 'Bit vector');
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  for (let index = 0; index < bits.length; index += 1) {
    packed[index >> 3] |= bits[index] << (7 - (index & 7));
  }
  return packed;
}

function unpackBits(bytes: Uint8Array, bitLength: number): Uint8Array {
  if (bytes.length !== Math.ceil(bitLength / 8)) throw new Error('Packed bit vector has an invalid length.');
  if (bitLength % 8 !== 0 && (bytes.at(-1)! & ((1 << (8 - (bitLength % 8))) - 1)) !== 0) {
    throw new Error('Packed bit vector padding must be zero.');
  }
  const bits = new Uint8Array(bitLength);
  for (let index = 0; index < bitLength; index += 1) {
    bits[index] = (bytes[index >> 3] >> (7 - (index & 7))) & 1;
  }
  return bits;
}

export function packAliceBatch(states: AlicePreparedStates, batchIndex: number): Uint8Array {
  validateAlicePreparedStates(states);
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= 16) throw new Error('Batch index is invalid.');
  const packed = new Uint8Array(16);
  const start = batchIndex * ENDPOINT_BB84_BATCH_SIZE;
  for (let offset = 0; offset < ENDPOINT_BB84_BATCH_SIZE; offset += 1) {
    const bitOffset = offset * 2;
    packed[bitOffset >> 3] |= states.bases[start + offset] << (7 - (bitOffset & 7));
    packed[(bitOffset + 1) >> 3] |= states.bits[start + offset] << (7 - ((bitOffset + 1) & 7));
  }
  return packed;
}

/** Decode one authenticated 64-qubit Alice batch at Bob's browser. */
export function unpackAliceBatch(packed: Uint8Array, batchIndex: number, target: AlicePreparedStates): void {
  validateAlicePreparedStates(target);
  if (packed.length !== 16 || !Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= 16) {
    throw new Error('Alice batch dimensions are invalid.');
  }
  const start = batchIndex * ENDPOINT_BB84_BATCH_SIZE;
  for (let offset = 0; offset < ENDPOINT_BB84_BATCH_SIZE; offset += 1) {
    const bitOffset = offset * 2;
    target.bases[start + offset] = (packed[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1;
    target.bits[start + offset] = (packed[(bitOffset + 1) >> 3] >> (7 - ((bitOffset + 1) & 7))) & 1;
  }
}

/** Decode a canonical packed bit vector used for public bases/sample values. */
export function unpackPackedBits(bytes: Uint8Array, bitLength: number): Uint8Array {
  return unpackBits(bytes, bitLength);
}

function matchingBasisIndices(aliceBases: Uint8Array, bobBases: Uint8Array): number[] {
  validateBases(aliceBases, 'Alice bases');
  validateBases(bobBases, 'Bob bases');
  const matches: number[] = [];
  for (let index = 0; index < ENDPOINT_BB84_QUBITS; index += 1) {
    if (aliceBases[index] === bobBases[index]) matches.push(index);
  }
  return matches;
}

function validateAlicePreparedStates(states: AlicePreparedStates): void {
  validateBits(states.bits, 'Alice bits');
  validateBases(states.bases, 'Alice bases');
  if (states.bits.length !== ENDPOINT_BB84_QUBITS || states.bases.length !== ENDPOINT_BB84_QUBITS) {
    throw new Error('Alice state vectors must contain exactly 1,024 values.');
  }
}

function validateBobMeasuredStates(states: BobMeasuredStates): void {
  validateBases(states.bases, 'Bob bases');
  validateBits(states.outcomes, 'Bob outcomes');
  validateBits(states.intercepted, 'Intercept flags');
  if (states.bases.length !== ENDPOINT_BB84_QUBITS || states.outcomes.length !== ENDPOINT_BB84_QUBITS
    || states.intercepted.length !== ENDPOINT_BB84_QUBITS) {
    throw new Error('Bob state vectors must contain exactly 1,024 values.');
  }
}

function validateBases(values: Uint8Array, name: string): void {
  if ([...values].some((value) => value !== 0 && value !== 1)) throw new Error(`${name} must contain only Z/X basis values.`);
}

function validateBits(values: Uint8Array, name: string): void {
  if ([...values].some((value) => value !== 0 && value !== 1)) throw new Error(`${name} must contain only bits.`);
}

function parity(bits: Uint8Array, start: number, length: number): 0 | 1 {
  let result = 0;
  for (let index = start; index < start + length; index += 1) result ^= bits[index];
  return result as 0 | 1;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u32be(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('Web Crypto digest is unavailable.');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}
