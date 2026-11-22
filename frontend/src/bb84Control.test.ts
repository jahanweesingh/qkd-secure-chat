import { describe, expect, it } from 'vitest';
import { computePairKeyId, deriveBb84ControlKeys, generateIdentity } from './e2ee';
import {
  Bb84ControlReceiver,
  Bb84ControlSender,
  decryptBb84Control,
  encryptBb84Control,
  normalizeBb84ControlEnvelope,
} from './bb84Control';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('BB84 control AEAD', () => {
  it('round-trips between directional endpoint keys without exposing plaintext in the envelope', async () => {
    const [alice, bob] = await Promise.all([generateIdentity(), generateIdentity()]);
    const roomId = 'demo-room';
    const pairId = await computePairKeyId(roomId, alice.publicKey, bob.publicKey);
    const runId = new Uint8Array(16).fill(5);
    const [aliceKeys, bobKeys] = await Promise.all([
      deriveBb84ControlKeys(alice, bob.publicKey, roomId, pairId, runId),
      deriveBb84ControlKeys(bob, alice.publicKey, roomId, pairId, runId),
    ]);
    const envelope = await encryptBb84Control(aliceKeys, {
      roomId, pairKeyId: pairId, senderKeyId: alice.publicKeyId, recipientKeyId: bob.publicKeyId,
    }, 0, { kind: 'run_offer', payload: { qubit_count: 1024 } });

    expect(JSON.stringify(envelope)).not.toContain('qubit_count');
    await expect(decryptBb84Control(bobKeys, envelope, {
      roomId, pairKeyId: pairId, runId, senderKeyId: alice.publicKeyId,
      recipientKeyId: bob.publicKeyId, sequence: 0,
    })).resolves.toEqual({ kind: 'run_offer', payload: { qubit_count: 1024 } });
  });

  it('rejects header substitution, ciphertext tampering, and a key from another run', async () => {
    const [alice, bob] = await Promise.all([generateIdentity(), generateIdentity()]);
    const roomId = 'demo-room';
    const pairId = await computePairKeyId(roomId, alice.publicKey, bob.publicKey);
    const runId = new Uint8Array(16).fill(3);
    const otherRunId = new Uint8Array(16).fill(4);
    const [aliceKeys, bobKeys, otherRunKeys] = await Promise.all([
      deriveBb84ControlKeys(alice, bob.publicKey, roomId, pairId, runId),
      deriveBb84ControlKeys(bob, alice.publicKey, roomId, pairId, runId),
      deriveBb84ControlKeys(bob, alice.publicKey, roomId, pairId, otherRunId),
    ]);
    const envelope = await encryptBb84Control(aliceKeys, {
      roomId, pairKeyId: pairId, senderKeyId: alice.publicKeyId, recipientKeyId: bob.publicKeyId,
    }, 7, { kind: 'sample_vote', payload: { accepted: true } });
    const expected = {
      roomId, pairKeyId: pairId, runId, senderKeyId: alice.publicKeyId,
      recipientKeyId: bob.publicKeyId, sequence: 7,
    };

    await expect(decryptBb84Control(bobKeys, { ...envelope, room_id: 'other-room' }, expected)).rejects.toThrow();
    await expect(decryptBb84Control(bobKeys, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` }, expected)).rejects.toThrow();
    await expect(decryptBb84Control(otherRunKeys, envelope, { ...expected, runId: otherRunId })).rejects.toThrow();
  });

  it('rejects malformed, replay-position, and extra-field envelopes before decryption', async () => {
    const identity = await generateIdentity();
    const peer = await generateIdentity();
    const roomId = 'demo-room';
    const pairId = await computePairKeyId(roomId, identity.publicKey, peer.publicKey);
    const runId = new Uint8Array(16).fill(1);
    const keys = await deriveBb84ControlKeys(identity, peer.publicKey, roomId, pairId, runId);
    const envelope = await encryptBb84Control(keys, {
      roomId, pairKeyId: pairId, senderKeyId: identity.publicKeyId, recipientKeyId: peer.publicKeyId,
    }, 0, { kind: 'abort', payload: { reason: 'timeout' } });

    expect(normalizeBb84ControlEnvelope(envelope)).toEqual(envelope);
    expect(() => normalizeBb84ControlEnvelope({ ...envelope, secret: 'forbidden' })).toThrow();
    await expect(decryptBb84Control(keys, envelope, {
      roomId, pairKeyId: pairId, runId, senderKeyId: identity.publicKeyId,
      recipientKeyId: peer.publicKeyId, sequence: 1,
    })).rejects.toThrow(/active run state/);
    expect(base64Url(runId)).toHaveLength(22);
  });

  it('uses monotonic per direction sequences and rejects replayed packets', async () => {
    const [alice, bob] = await Promise.all([generateIdentity(), generateIdentity()]);
    const roomId = 'demo-room';
    const pairId = await computePairKeyId(roomId, alice.publicKey, bob.publicKey);
    const runId = new Uint8Array(16).fill(8);
    const [aliceKeys, bobKeys] = await Promise.all([
      deriveBb84ControlKeys(alice, bob.publicKey, roomId, pairId, runId),
      deriveBb84ControlKeys(bob, alice.publicKey, roomId, pairId, runId),
    ]);
    const sender = new Bb84ControlSender(aliceKeys, {
      roomId, pairKeyId: pairId, senderKeyId: alice.publicKeyId, recipientKeyId: bob.publicKeyId,
    });
    const receiver = new Bb84ControlReceiver(bobKeys, {
      roomId, pairKeyId: pairId, runId, senderKeyId: alice.publicKeyId,
      recipientKeyId: bob.publicKeyId,
    });
    const first = await sender.seal({ kind: 'one', payload: {} });
    const second = await sender.seal({ kind: 'two', payload: {} });
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    await expect(receiver.open(first)).resolves.toEqual({ kind: 'one', payload: {} });
    await expect(receiver.open(first)).rejects.toThrow(/active run state/);
    await expect(receiver.open(second)).resolves.toEqual({ kind: 'two', payload: {} });
  });
});
