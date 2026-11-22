/** Browser-to-browser BB84 protocol orchestration for the chat lab. */

import {
  calculateSampleQber,
  AliceReconciliation,
  answerParityQuery,
  applyReconciliationFlip,
  createSampleCommitment,
  createToeplitzSeed,
  deriveSampleIndices,
  discloseSample,
  estimateEducationalSecretBits,
  generateAlicePreparedStates,
  measureAtBob,
  packAliceBatch,
  packBits,
  siftLocalCandidate,
  toeplitzPrivacyAmplify,
  unpackAliceBatch,
  unpackPackedBits,
} from './bb84Endpoint';
import type {
  AlicePreparedStates,
  BobMeasuredStates,
  EndpointBb84Config,
  EndpointRole,
  SiftedCandidate,
} from './bb84Endpoint';
import type { Bb84ControlPayload } from './bb84Control';

export type EndpointBb84Progress = {
  status: 'idle' | 'preparing' | 'exchanging' | 'sifting' | 'sampling' | 'reconciling' | 'privacy_amplification' | 'key_confirmation' | 'complete' | 'failed';
  role: EndpointRole | null;
  percent: number;
  qberPpm: number | null;
  error: string | null;
};

export const EMPTY_ENDPOINT_BB84_PROGRESS: EndpointBb84Progress = {
  status: 'idle', role: null, percent: 0, qberPpm: null, error: null,
};

export interface EndpointBb84Wire {
  send: (message: Bb84ControlPayload) => Promise<void>;
  onProgress: (progress: EndpointBb84Progress) => void;
  onContribution?: (contribution: Uint8Array, transcriptHash: Uint8Array) => void | Promise<void>;
}

const BATCHES = 16;

export class EndpointBb84ChatSession {
  private progress: EndpointBb84Progress;
  private config: (EndpointBb84Config & { qberThresholdPpm: number }) | null;
  private alice: AlicePreparedStates | null = null;
  private bob: BobMeasuredStates | null = null;
  private candidate: SiftedCandidate | null = null;
  private incomingBatch = 0;
  private aliceSampleSeed: Uint8Array | null = null;
  private bobSampleSeed: Uint8Array | null = null;
  private aliceSampleCommitment: Uint8Array | null = null;
  private bobSampleCommitment: Uint8Array | null = null;
  private sampleIndices: Uint16Array | null = null;
  private ownSampleValues: Uint8Array | null = null;
  private peerSampleValues: Uint8Array | null = null;
  private sampleSent = false;
  private completed = false;
  private contributionReady = false;
  private retainedBits: Uint8Array | null = null;
  private reconciler: AliceReconciliation | null = null;
  private reconciliationQueryId = 0;
  private lastBobQueryId: number | null = null;
  private transcriptEvents: Array<{ role: EndpointRole; kind: string; payload: Record<string, unknown> }> = [];

  constructor(
    readonly role: EndpointRole,
    private readonly runId: Uint8Array,
    private readonly wire: EndpointBb84Wire,
    config: (EndpointBb84Config & { qberThresholdPpm: number }) | null = null,
  ) {
    if (runId.length !== 16) throw new Error('BB84 run identifier must be 16 bytes.');
    this.config = config;
    this.progress = { ...EMPTY_ENDPOINT_BB84_PROGRESS, status: 'preparing', role };
    this.publish();
  }

  get currentStatus(): EndpointBb84Progress['status'] { return this.progress.status; }

  markKeyConfirmed(): void {
    if (!this.contributionReady || this.completed) throw new Error('BB84 contribution is not ready for activation.');
    this.completed = true;
    this.progress = { ...this.progress, status: 'complete', percent: 100, error: null };
    this.retainedBits?.fill(0);
    this.publish();
  }

  async startAlice(config: EndpointBb84Config & { qberThresholdPpm: number }): Promise<void> {
    if (this.role !== 'alice' || this.config || this.completed) throw new Error('This BB84 run cannot be started.');
    this.validateConfig(config);
    this.config = config;
    this.alice = generateAlicePreparedStates();
    this.progress = { ...this.progress, status: 'exchanging', percent: 5 };
    await this.sendMessage('run_offer', {
      qubitCount: 1_024,
      noisePpm: config.noisePpm,
      interceptPpm: config.interceptPpm,
      qberThresholdPpm: config.qberThresholdPpm,
    });
    for (let batchIndex = 0; batchIndex < BATCHES; batchIndex += 1) {
      await this.sendMessage('alice_batch', {
        batchIndex,
        packed: toBase64Url(packAliceBatch(this.alice, batchIndex)),
      });
      this.progress = { ...this.progress, percent: 5 + Math.floor(((batchIndex + 1) / BATCHES) * 55) };
      this.publish();
    }
  }

  async receive(message: Bb84ControlPayload): Promise<void> {
    if (this.completed) throw new Error('This BB84 run is already complete.');
    this.transcriptEvents.push({ role: this.role === 'alice' ? 'bob' : 'alice', kind: message.kind, payload: message.payload });
    const payload = message.payload;
    if (message.kind === 'run_offer' && this.role === 'bob') {
      requireExactFields(payload, ['qubitCount', 'noisePpm', 'interceptPpm', 'qberThresholdPpm']);
      if (this.config || this.incomingBatch !== 0) throw new Error('Unexpected or replayed BB84 run offer.');
      const config = {
        noisePpm: readInteger(payload, 'noisePpm', 0, 250_000),
        interceptPpm: readInteger(payload, 'interceptPpm', 0, 1_000_000),
        qberThresholdPpm: readInteger(payload, 'qberThresholdPpm', 0, 250_000),
      };
      if (readInteger(payload, 'qubitCount', 1_024, 1_024) !== 1_024) throw new Error('Unsupported BB84 qubit count.');
      this.validateConfig(config);
      this.config = config;
      this.alice = { bits: new Uint8Array(1_024), bases: new Uint8Array(1_024) };
      this.progress = { ...this.progress, status: 'exchanging', percent: 5 };
      this.publish();
      return;
    }
    if (message.kind === 'alice_batch' && this.role === 'bob') {
      requireExactFields(payload, ['batchIndex', 'packed']);
      if (!this.config || !this.alice) throw new Error('Alice batch arrived before the run offer.');
      const batchIndex = readInteger(payload, 'batchIndex', 0, BATCHES - 1);
      if (batchIndex !== this.incomingBatch) throw new Error('BB84 batch sequence was replayed or skipped.');
      unpackAliceBatch(fromBase64Url(readString(payload, 'packed')), batchIndex, this.alice);
      this.incomingBatch += 1;
      this.progress = { ...this.progress, status: 'exchanging', percent: 5 + Math.floor((this.incomingBatch / BATCHES) * 55) };
      this.publish();
      if (this.incomingBatch === BATCHES) await this.measureAndAnnounceBases();
      return;
    }
    if (message.kind === 'bob_bases' && this.role === 'alice') {
      requireExactFields(payload, ['qubitCount', 'packedBases', 'sampleCommitment']);
      if (!this.config || !this.alice || this.bob || payload.qubitCount !== 1_024) {
        throw new Error('Unexpected Bob basis announcement.');
      }
      const bases = unpackPackedBits(fromBase64Url(readString(payload, 'packedBases')), 1_024);
      this.bobSampleCommitment = fromBase64Url(readString(payload, 'sampleCommitment'));
      if (this.bobSampleCommitment.length !== 32) throw new Error('Bob sample commitment has an invalid length.');
      this.bob = { bases, outcomes: new Uint8Array(1_024), intercepted: new Uint8Array(1_024) };
      this.candidate = siftLocalCandidate('alice', this.alice, this.bob);
      this.progress = { ...this.progress, status: 'sifting', percent: 70 };
      this.publish();
      this.aliceSampleSeed = randomBytes(32);
      this.aliceSampleCommitment = await createSampleCommitment(this.runId, 'alice', this.aliceSampleSeed);
      await this.sendMessage('alice_sample_commitment', {
        commitment: toBase64Url(this.aliceSampleCommitment),
      });
      return;
    }
    if (message.kind === 'alice_sample_commitment' && this.role === 'bob') {
      requireExactFields(payload, ['commitment']);
      if (!this.candidate || !this.bob || this.aliceSampleCommitment) throw new Error('Unexpected or replayed Alice sample commitment.');
      this.aliceSampleCommitment = fromBase64Url(readString(payload, 'commitment'));
      if (this.aliceSampleCommitment.length !== 32) throw new Error('Alice sample commitment has an invalid length.');
      if (!this.bobSampleSeed) throw new Error('Bob sample seed was not prepared.');
      await this.sendMessage('bob_sample_seed', { seed: toBase64Url(this.bobSampleSeed) });
      return;
    }
    if (message.kind === 'bob_sample_seed' && this.role === 'alice') {
      requireExactFields(payload, ['seed']);
      if (!this.candidate || !this.bob || this.bobSampleSeed || !this.bobSampleCommitment || !this.aliceSampleSeed) {
        throw new Error('Unexpected or replayed Bob sample seed.');
      }
      this.bobSampleSeed = fromBase64Url(readString(payload, 'seed'));
      if (this.bobSampleSeed.length !== 32
        || !bytesEqual(await createSampleCommitment(this.runId, 'bob', this.bobSampleSeed), this.bobSampleCommitment)) {
        throw new Error('Bob sample seed does not match its commitment.');
      }
      await this.prepareSample();
      await this.sendMessage('alice_sample_seed', { seed: toBase64Url(this.aliceSampleSeed) });
      await this.sendSampleValues('alice');
      return;
    }
    if (message.kind === 'alice_sample_seed' && this.role === 'bob') {
      requireExactFields(payload, ['seed']);
      if (!this.candidate || !this.bob || this.aliceSampleSeed || !this.aliceSampleCommitment || !this.bobSampleSeed) {
        throw new Error('Unexpected or replayed Alice sample seed.');
      }
      this.aliceSampleSeed = fromBase64Url(readString(payload, 'seed'));
      if (this.aliceSampleSeed.length !== 32
        || !bytesEqual(await createSampleCommitment(this.runId, 'alice', this.aliceSampleSeed), this.aliceSampleCommitment)) {
        throw new Error('Alice sample seed does not match its commitment.');
      }
      await this.prepareSample();
      await this.sendSampleValues('bob');
      return;
    }
    if (message.kind === 'sample_values') {
      requireExactFields(payload, ['role', 'packedValues']);
      const expectedRole = this.role === 'alice' ? 'bob' : 'alice';
      if (payload.role !== expectedRole || this.peerSampleValues || !this.sampleIndices) {
        throw new Error('Unexpected or replayed BB84 sample values.');
      }
      this.peerSampleValues = unpackPackedBits(
        fromBase64Url(readString(payload, 'packedValues')),
        this.sampleIndices.length,
      );
      await this.maybeFinishQber();
      return;
    }
    if (message.kind === 'reconciliation_query' && this.role === 'bob') {
      requireExactFields(payload, ['queryId', 'blockIndex', 'start', 'length', 'aliceParity']);
      if (!this.retainedBits || this.lastBobQueryId !== null) throw new Error('Unexpected reconciliation query.');
      const query = {
        queryId: readInteger(payload, 'queryId', 0, 511),
        blockIndex: readInteger(payload, 'blockIndex', 0, 767),
        start: readInteger(payload, 'start', 0, 767),
        length: readInteger(payload, 'length', 1, 16),
        aliceParity: readInteger(payload, 'aliceParity', 0, 1) as 0 | 1,
      };
      if (query.queryId !== this.reconciliationQueryId || query.start + query.length > this.retainedBits.length) {
        throw new Error('Reconciliation query sequence or range is invalid.');
      }
      this.lastBobQueryId = query.queryId;
      this.reconciliationQueryId += 1;
      await this.sendMessage('reconciliation_reply', {
        queryId: query.queryId,
        parityDiffers: answerParityQuery(this.retainedBits, query).parityDiffers,
      });
      return;
    }
    if (message.kind === 'reconciliation_reply' && this.role === 'alice') {
      requireExactFields(payload, ['queryId', 'parityDiffers']);
      if (!this.reconciler) throw new Error('Unexpected reconciliation reply.');
      const queryId = readInteger(payload, 'queryId', 0, 511);
      if (typeof payload.parityDiffers !== 'boolean') throw new Error('Parity reply flag is invalid.');
      const flip = this.reconciler.acceptReply({ queryId, parityDiffers: payload.parityDiffers });
      if (flip) {
        await this.sendMessage('reconciliation_flip', { queryId: flip.queryId, position: flip.position });
      } else {
        await this.sendMessage('reconciliation_ack', { queryId });
      }
      await this.sendNextReconciliationQuery();
      return;
    }
    if (message.kind === 'reconciliation_flip' && this.role === 'bob') {
      requireExactFields(payload, ['queryId', 'position']);
      if (!this.retainedBits || this.lastBobQueryId === null) throw new Error('Unexpected reconciliation correction.');
      const queryId = readInteger(payload, 'queryId', 0, 511);
      const position = readInteger(payload, 'position', 0, this.retainedBits.length - 1);
      if (queryId !== this.lastBobQueryId) throw new Error('Reconciliation correction was replayed or mismatched.');
      applyReconciliationFlip(this.retainedBits, { queryId, position });
      this.lastBobQueryId = null;
      return;
    }
    if (message.kind === 'reconciliation_ack' && this.role === 'bob') {
      requireExactFields(payload, ['queryId']);
      if (this.lastBobQueryId === null || readInteger(payload, 'queryId', 0, 511) !== this.lastBobQueryId) {
        throw new Error('Reconciliation acknowledgement was replayed or mismatched.');
      }
      this.lastBobQueryId = null;
      return;
    }
    if (message.kind === 'toeplitz_seed' && this.role === 'bob') {
      requireExactFields(payload, ['inputBits', 'leakageBits', 'queryCount', 'seedBits']);
      if (!this.retainedBits || !this.config) throw new Error('Toeplitz seed arrived before reconciliation.');
      const inputBits = readInteger(payload, 'inputBits', 1, 768);
      const leakageBits = readInteger(payload, 'leakageBits', 0, 1_024);
      const queryCount = readInteger(payload, 'queryCount', 0, 512);
      const seed = unpackPackedBits(fromBase64Url(readString(payload, 'seedBits')), inputBits + 127);
      if (this.lastBobQueryId !== null || inputBits !== this.retainedBits.length || queryCount !== this.reconciliationQueryId
        || leakageBits !== queryCount * 2
        || estimateEducationalSecretBits(inputBits, leakageBits, this.progress.qberPpm ?? 1_000_000) < 128) {
        throw new Error('Toeplitz parameters do not match the completed reconciliation.');
      }
      this.progress = { ...this.progress, status: 'privacy_amplification', percent: 95 };
      this.publish();
      await this.finishPrivacyAmplification(this.retainedBits, seed);
      return;
    }
    throw new Error(`BB84 message ${message.kind} is invalid for ${this.role} state.`);
  }

  abort(reason: string): void {
    this.completed = true;
    this.progress = { ...this.progress, status: 'failed', error: reason };
    this.clearSecrets();
    this.publish();
  }

  private async measureAndAnnounceBases(): Promise<void> {
    if (!this.alice || !this.config) throw new Error('BB84 inputs are incomplete.');
    this.bob = measureAtBob(this.alice, this.config);
    this.candidate = siftLocalCandidate('bob', this.alice, this.bob);
    this.bobSampleSeed = randomBytes(32);
    this.bobSampleCommitment = await createSampleCommitment(this.runId, 'bob', this.bobSampleSeed);
    this.progress = { ...this.progress, status: 'sifting', percent: 65 };
    this.publish();
    await this.sendMessage('bob_bases', {
      qubitCount: 1_024,
      packedBases: toBase64Url(packBits(this.bob.bases)),
      sampleCommitment: toBase64Url(this.bobSampleCommitment),
    });
  }

  private async prepareSample(): Promise<void> {
    if (!this.alice || !this.bob || !this.candidate || !this.aliceSampleSeed || !this.bobSampleSeed) {
      throw new Error('BB84 sample inputs are incomplete.');
    }
    this.sampleIndices = await deriveSampleIndices(
      this.runId,
      this.aliceSampleSeed,
      this.bobSampleSeed,
      this.alice.bases,
      this.bob.bases,
    );
    this.ownSampleValues = discloseSample(this.candidate, this.sampleIndices);
    this.progress = { ...this.progress, status: 'sampling', percent: 85 };
    this.publish();
  }

  private async sendSampleValues(role: EndpointRole): Promise<void> {
    if (!this.ownSampleValues || !this.sampleIndices) throw new Error('BB84 sample values are not ready.');
    this.sampleSent = true;
    await this.sendMessage('sample_values', {
      role,
      packedValues: toBase64Url(packBits(this.ownSampleValues)),
    });
    await this.maybeFinishQber();
  }

  private async maybeFinishQber(): Promise<void> {
    if (!this.sampleSent || !this.ownSampleValues || !this.peerSampleValues || !this.config || this.completed) return;
    const qber = this.role === 'alice'
      ? calculateSampleQber(this.ownSampleValues, this.peerSampleValues)
      : calculateSampleQber(this.peerSampleValues, this.ownSampleValues);
    const accepted = qber.qberPpm <= this.config.qberThresholdPpm;
    this.progress = {
      ...this.progress,
      status: accepted ? 'reconciling' : 'failed',
      percent: accepted ? 88 : 100,
      qberPpm: qber.qberPpm,
      error: accepted
        ? null
        : 'Sample QBER exceeded the configured limit. BB84 stopped without producing a contribution.',
    };
    this.publish();
    if (!accepted) {
      this.completed = true;
      this.clearSecrets();
      return;
    }
    const retainedBits = removeSample(this.candidate!.indices, this.candidate!.bits, this.sampleIndices!);
    this.retainedBits = retainedBits;
    if (this.role === 'alice') {
      this.reconciler = new AliceReconciliation(retainedBits);
      await this.sendNextReconciliationQuery();
    }
  }

  private async sendNextReconciliationQuery(): Promise<void> {
    if (!this.reconciler || !this.retainedBits || this.completed) return;
    const query = this.reconciler.nextQuery();
    if (query) {
      await this.sendMessage('reconciliation_query', {
        queryId: query.queryId,
        blockIndex: query.blockIndex,
        start: query.start,
        length: query.length,
        aliceParity: query.aliceParity,
      });
      return;
    }
    const leakageBits = this.reconciler.leakageBits;
    const queryCount = this.reconciler.queryCount;
    if (estimateEducationalSecretBits(
      this.retainedBits.length, leakageBits, this.progress.qberPpm ?? 1_000_000,
    ) < 128) {
      this.fail('Reconciliation leakage leaves fewer than 128 educational output bits.');
      return;
    }
    this.progress = { ...this.progress, status: 'privacy_amplification', percent: 92 };
    this.publish();
    const seed = createToeplitzSeed(this.retainedBits.length);
    await this.sendMessage('toeplitz_seed', {
      inputBits: this.retainedBits.length,
      leakageBits,
      queryCount,
      seedBits: toBase64Url(packBits(seed)),
    });
    await this.finishPrivacyAmplification(this.retainedBits, seed);
  }

  private async finishPrivacyAmplification(inputBits: Uint8Array, seedBits: Uint8Array): Promise<void> {
    const contribution = packBits(toeplitzPrivacyAmplify(inputBits, seedBits));
    if (contribution.length !== 16) throw new Error('BB84 contribution did not contain 128 bits.');
    const transcriptHash = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({
        protocol: 'bb84-endpoint-v1/pre-confirmation',
        runId: toBase64Url(this.runId),
        events: this.transcriptEvents
          .map((event, index) => ({ ...event, index }))
          .sort((left, right) => left.role.localeCompare(right.role) || left.index - right.index)
          .map(({ role, kind, payload }) => ({ role, kind, payload })),
      })),
    ));
    this.contributionReady = true;
    this.progress = {
      ...this.progress,
      status: this.wire.onContribution ? 'key_confirmation' : 'complete',
      percent: this.wire.onContribution ? 98 : 100,
      error: null,
    };
    await this.wire.onContribution?.(contribution.slice(), transcriptHash);
    if (!this.wire.onContribution) this.completed = true;
    this.clearSecrets();
    inputBits.fill(0);
    seedBits.fill(0);
    contribution.fill(0);
    this.publish();
  }

  private async sendMessage(kind: string, payload: Record<string, unknown>): Promise<void> {
    this.transcriptEvents.push({ role: this.role, kind, payload });
    await this.wire.send({ kind, payload });
  }

  private fail(reason: string): void {
    this.completed = true;
    this.progress = { ...this.progress, status: 'failed', percent: 100, error: reason };
    this.clearSecrets();
    this.publish();
  }

  private validateConfig(config: EndpointBb84Config & { qberThresholdPpm: number }): void {
    for (const [name, value, max] of [
      ['noisePpm', config.noisePpm, 250_000],
      ['interceptPpm', config.interceptPpm, 1_000_000],
      ['qberThresholdPpm', config.qberThresholdPpm, 250_000],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} is out of range.`);
    }
  }

  private clearSecrets(): void {
    this.alice?.bits.fill(0);
    this.bob?.outcomes.fill(0);
    this.aliceSampleSeed?.fill(0);
    this.bobSampleSeed?.fill(0);
    this.aliceSampleCommitment?.fill(0);
    this.bobSampleCommitment?.fill(0);
    this.ownSampleValues?.fill(0);
    this.peerSampleValues?.fill(0);
    this.candidate?.bits.fill(0);
    this.retainedBits?.fill(0);
    this.transcriptEvents.length = 0;
  }

  private publish(): void { this.wire.onProgress({ ...this.progress }); }
}

function readInteger(payload: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`BB84 field ${key} is invalid.`);
  }
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function removeSample(indices: Uint16Array, bits: Uint8Array, sampleIndices: Uint16Array): Uint8Array {
  if (indices.length !== bits.length) throw new Error('Sifted candidate index/bit dimensions differ.');
  const disclosed = new Set(sampleIndices);
  const retained: number[] = [];
  for (let offset = 0; offset < indices.length; offset += 1) {
    if (!disclosed.has(indices[offset])) retained.push(bits[offset]);
  }
  if (retained.length < 1 || retained.length > 768) throw new Error('Retained BB84 candidate length is unsupported.');
  return Uint8Array.from(retained);
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length > 2_048) throw new Error(`BB84 field ${key} is invalid.`);
  return value;
}

function requireExactFields(payload: Record<string, unknown>, fields: string[]): void {
  const actual = Object.keys(payload).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error('BB84 protocol message has unexpected or missing fields.');
  }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('BB84 value is not canonical base64url.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new Error('BB84 value is not canonical base64url.');
  return bytes;
}
