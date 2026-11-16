import { describe, expect, it, vi } from 'vitest';
import {
  decryptText,
  computePairKeyId,
  deriveContext,
  E2EE_VERSION,
  encryptText,
  generateIdentity,
  isEncryptedPayload,
} from './e2ee';

describe('Phase 4 browser encryption', () => {
  it('matches the backend pair-ID vector with raw byte ordering', async () => {
    const left = 'BAfw4JAvNFqMGJA31Y7nbxq5LVOcaSTeWIYyIaw7RCRBWZjLh2rMXiedLTdoH7Hoe8CGqxMmZzd-hlyJY1v1h4A';
    const right = 'BAL9qQygQBQUvnJDexIwQHW26icUi84IvRQuTxK9c-s9bh1gy57tiwagi8_MxXgRf57BO747UnNO6edX4lHN3-g';
    await expect(computePairKeyId('demo', left, right))
      .resolves.toBe('XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU');
    await expect(computePairKeyId('demo', right, left))
      .resolves.toBe('XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU');
  });

  it('derives matching contexts and decrypts in both directions', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceContext = await deriveContext(alice, bob.publicKey, bob.publicKeyId, 'ROOM-42');
    const bobContext = await deriveContext(bob, alice.publicKey, alice.publicKeyId, 'ROOM-42');

    expect(aliceContext.keyId).toBe(bobContext.keyId);
    expect(aliceContext.verificationCode).toBe(bobContext.verificationCode);
    expect(aliceContext.verificationCode).toMatch(/^\d{4} \d{4} \d{4}$/);

    const aliceBinding = {
      roomId: 'ROOM-42',
      senderId: 'alice-client',
      senderName: 'Alice',
      clientMessageId: 'message-1',
    };
    const alicePayload = await encryptText(aliceContext, 'A private hello', aliceBinding);
    expect(alicePayload.ciphertext).not.toContain('private');
    await expect(decryptText(bobContext, alicePayload, aliceBinding))
      .resolves.toBe('A private hello');

    const bobBinding = {
      roomId: 'ROOM-42',
      senderId: 'bob-client',
      senderName: 'Bob',
      clientMessageId: 'message-2',
    };
    const bobPayload = await encryptText(bobContext, 'A private reply', bobBinding);
    expect(bobPayload.ciphertext).not.toContain('private');
    await expect(decryptText(aliceContext, bobPayload, bobBinding))
      .resolves.toBe('A private reply');
  });

  it('fails after bounded retries when the random source repeats an IV', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const context = await deriveContext(alice, bob.publicKey, bob.publicKeyId, 'ROOM-42');
    const binding = {
      roomId: 'ROOM-42',
      senderId: 'alice-client',
      senderName: 'Alice',
      clientMessageId: 'duplicate-iv-1',
    };
    const repeatedRandom = <T extends ArrayBufferView | null>(array: T): T => {
      if (array) {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0x5a);
      }
      return array;
    };
    const randomSpy = vi.spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(repeatedRandom);

    try {
      await encryptText(context, 'first message', binding);
      await expect(encryptText(context, 'second message', {
        ...binding,
        clientMessageId: 'duplicate-iv-2',
      })).rejects.toThrow(/unique AES-GCM IV/i);
      expect(randomSpy).toHaveBeenCalledTimes(17);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('rejects modified authenticated metadata or ciphertext', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceContext = await deriveContext(alice, bob.publicKey, bob.publicKeyId, 'ROOM-42');
    const bobContext = await deriveContext(bob, alice.publicKey, alice.publicKeyId, 'ROOM-42');
    const binding = {
      roomId: 'ROOM-42',
      senderId: 'alice-client',
      senderName: 'Alice',
      clientMessageId: 'message-2',
    };
    const payload = await encryptText(aliceContext, 'Integrity matters', binding);

    await expect(decryptText(bobContext, payload, { ...binding, senderName: 'Mallory' }))
      .rejects.toThrow();
    const tail = payload.ciphertext.at(-1) === 'A' ? 'B' : 'A';
    await expect(decryptText(
      bobContext,
      { ...payload, ciphertext: `${payload.ciphertext.slice(0, -1)}${tail}` },
      binding,
    )).rejects.toThrow();
  });

  it('validates the fixed encrypted envelope format', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const context = await deriveContext(alice, bob.publicKey, bob.publicKeyId, 'ROOM-42');
    const payload = await encryptText(context, 'hello', {
      roomId: 'ROOM-42',
      senderId: 'alice-client',
      senderName: 'Alice',
      clientMessageId: 'message-3',
    });

    expect(isEncryptedPayload(payload)).toBe(true);
    expect(isEncryptedPayload({ ...payload, version: 'future-version' })).toBe(false);
    expect(payload.version).toBe(E2EE_VERSION);
    expect(payload.iv).toHaveLength(16);
  });

  it('does not derive a peer context from the same identity', async () => {
    const alice = await generateIdentity();
    await expect(deriveContext(alice, alice.publicKey, alice.publicKeyId, 'ROOM-42'))
      .rejects.toThrow(/different encryption identity/i);
  });
});
