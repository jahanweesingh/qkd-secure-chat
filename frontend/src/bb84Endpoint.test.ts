import { describe, expect, it } from 'vitest';
import {
  AliceReconciliation,
  answerParityQuery,
  applyReconciliationFlip,
  calculateSampleQber,
  createSampleCommitment,
  createToeplitzSeed,
  deriveSampleIndices,
  discloseSample,
  estimateEducationalSecretBits,
  generateAlicePreparedStates,
  measureAtBob,
  packAliceBatch,
  siftLocalCandidate,
  toeplitzPrivacyAmplify,
} from './bb84Endpoint';

function deterministicRandom(seed = 0x12345678) {
  let state = seed >>> 0;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

describe('endpoint BB84 simulation and processing', () => {
  it('creates Alice preparation and Bob measurement independently in bounded vectors', () => {
    const alice = generateAlicePreparedStates(deterministicRandom(1));
    const bob = measureAtBob(alice, { noisePpm: 0, interceptPpm: 0 }, deterministicRandom(2));

    expect(alice.bits).toHaveLength(1024);
    expect(alice.bases).toHaveLength(1024);
    expect(bob.bases).toHaveLength(1024);
    expect(bob.outcomes).toHaveLength(1024);
    expect(bob.intercepted.every((value) => value === 0)).toBe(true);
    expect(packAliceBatch(alice, 0)).toHaveLength(16);
    expect(packAliceBatch(alice, 15)).toHaveLength(16);
    expect(() => packAliceBatch(alice, 16)).toThrow(/Batch index/);
  });

  it('both endpoints sift from their own local data and agree on sample positions', async () => {
    const alice = generateAlicePreparedStates(deterministicRandom(3));
    const bob = measureAtBob(alice, { noisePpm: 0, interceptPpm: 0 }, deterministicRandom(4));
    const aliceCandidate = siftLocalCandidate('alice', alice, bob);
    const bobCandidate = siftLocalCandidate('bob', alice, bob);
    expect(aliceCandidate.indices).toEqual(bobCandidate.indices);
    expect(aliceCandidate.bits).not.toBe(bobCandidate.bits);

    const runId = new Uint8Array(16).fill(7);
    const aliceSeed = new Uint8Array(32).fill(11);
    const bobSeed = new Uint8Array(32).fill(29);
    const [aliceCommit, bobCommit] = await Promise.all([
      createSampleCommitment(runId, 'alice', aliceSeed),
      createSampleCommitment(runId, 'bob', bobSeed),
    ]);
    expect(aliceCommit).not.toEqual(bobCommit);
    const indicesA = await deriveSampleIndices(runId, aliceSeed, bobSeed, alice.bases, bob.bases);
    const indicesB = await deriveSampleIndices(runId, aliceSeed, bobSeed, alice.bases, bob.bases);
    expect(indicesA).toEqual(indicesB);
    expect(indicesA).toHaveLength(Math.floor(aliceCandidate.bits.length / 4));
    expect(discloseSample(aliceCandidate, indicesA)).toHaveLength(indicesA.length);
    expect(calculateSampleQber(
      discloseSample(aliceCandidate, indicesA),
      discloseSample(bobCandidate, indicesA),
    ).qberPpm).toBe(0);
  });

  it('uses bounded Eve/noise parameters and rejects invalid settings', () => {
    const alice = generateAlicePreparedStates(deterministicRandom(8));
    const bob = measureAtBob(alice, { noisePpm: 250_000, interceptPpm: 1_000_000 }, deterministicRandom(9));
    expect(bob.intercepted.every((value) => value === 1)).toBe(true);
    expect(() => measureAtBob(alice, { noisePpm: 250_001, interceptPpm: 0 })).toThrow(/noisePpm/);
    expect(() => measureAtBob(alice, { noisePpm: 0, interceptPpm: -1 })).toThrow(/interceptPpm/);
  });

  it('reconciles one error in each odd-parity block without either side reading the other buffer', () => {
    const aliceBits = new Uint8Array(32);
    const bobBits = new Uint8Array(32);
    bobBits[3] = 1;
    bobBits[17] = 1;
    const alice = new AliceReconciliation(aliceBits);

    let guard = 0;
    let query = alice.nextQuery();
    while (query) {
      const reply = answerParityQuery(bobBits, query);
      const flip = alice.acceptReply(reply);
      if (flip) applyReconciliationFlip(bobBits, flip);
      query = alice.nextQuery();
      guard += 1;
      expect(guard).toBeLessThan(32);
    }

    expect(bobBits).toEqual(aliceBits);
    expect(alice.queryCount).toBeGreaterThan(0);
    expect(alice.leakageBits).toBe(alice.queryCount * 2);
  });

  it('derives matching Toeplitz outputs locally and applies the educational entropy floor', () => {
    const random = deterministicRandom(13);
    const inputA = Uint8Array.from({ length: 256 }, (_, index) => index % 2);
    const inputB = new Uint8Array(inputA);
    const seedA = createToeplitzSeed(inputA.length, random);
    const outputA = toeplitzPrivacyAmplify(inputA, seedA);
    const outputB = toeplitzPrivacyAmplify(inputB, seedA);
    expect(seedA).toHaveLength(inputA.length + 127);
    expect(outputA).toHaveLength(128);
    expect(outputB).toEqual(outputA);
    expect(estimateEducationalSecretBits(400, 40, 0)).toBe(328);
    expect(estimateEducationalSecretBits(100, 100, 0)).toBe(0);
  });
});
