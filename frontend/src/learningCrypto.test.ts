import { describe, expect, it } from 'vitest';
import { LEARNING_MAX_BYTES, runLearningEncryption } from './learningCrypto';

const encoder = new TextEncoder();
const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

describe('isolated visible-key learning encryption', () => {
  it('really encrypts and decrypts hi with the displayed key, IV and authentication tag', async () => {
    const result = await runLearningEncryption('hi');
    expect(result.plaintext).toBe('hi');
    expect(result.decrypted).toBe('hi');
    expect(result.plaintextBytes).toBe(2);
    expect(result.ciphertextHex).toHaveLength(4);
    expect(result.tagHex).toHaveLength(32);
    expect(result.combinedCiphertextHex).toBe(result.ciphertextHex + result.tagHex);
    expect(result.ivHex).toHaveLength(24);
    expect(result.aliceToBobKeyHex).toHaveLength(64);
    expect(result.bobToAliceKeyHex).toHaveLength(64);
    expect(result.aliceToBobKeyHex).not.toBe(result.bobToAliceKeyHex);
    const key = await crypto.subtle.importKey('raw', fromHex(result.aliceToBobKeyHex), 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: fromHex(result.ivHex), tagLength: 128, additionalData: encoder.encode(result.aad),
    }, key, fromHex(result.combinedCiphertextHex));
    expect(new TextDecoder().decode(plaintext)).toBe('hi');
  });

  it('allows independent reconstruction of both shared secrets and directional keys from the displayed values', async () => {
    const result = await runLearningEncryption('independent check');
    const importPrivate = (privateHex: string, publicHex: string) => {
      const raw = fromHex(publicHex);
      return crypto.subtle.importKey('jwk', {
        kty: 'EC', crv: 'P-256', d: base64url(fromHex(privateHex)),
        x: base64url(raw.slice(1, 33)), y: base64url(raw.slice(33, 65)),
      }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    };
    const [alicePrivate, bobPrivate, alicePublic, bobPublic] = await Promise.all([
      importPrivate(result.alicePrivateHex, result.alicePublicHex),
      importPrivate(result.bobPrivateHex, result.bobPublicHex),
      crypto.subtle.importKey('raw', fromHex(result.alicePublicHex), { name: 'ECDH', namedCurve: 'P-256' }, false, []),
      crypto.subtle.importKey('raw', fromHex(result.bobPublicHex), { name: 'ECDH', namedCurve: 'P-256' }, false, []),
    ]);
    const secrets = await Promise.all([
      crypto.subtle.deriveBits({ name: 'ECDH', public: bobPublic }, alicePrivate, 256),
      crypto.subtle.deriveBits({ name: 'ECDH', public: alicePublic }, bobPrivate, 256),
    ]);
    expect(secrets.map(toHex)).toEqual([result.sharedSecretHex, result.sharedSecretHex]);
    for (const secret of secrets) {
      const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
      for (const [info, expected] of [[result.aliceToBobInfo, result.aliceToBobKeyHex], [result.bobToAliceInfo, result.bobToAliceKeyHex]]) {
        const key = await crypto.subtle.deriveBits({
          name: 'HKDF', hash: 'SHA-256', salt: fromHex(result.hkdfSaltHex), info: encoder.encode(info),
        }, material, 256);
        expect(toHex(key)).toBe(expected);
      }
    }
    expect(result.aliceToBobInfo).toContain('LEARNING-ONLY');
    expect(result.aliceToBobInfo).toContain(result.alicePublicHex);
    expect(result.bobToAliceInfo).toContain(result.bobPublicHex);
  });

  it('creates fresh identities, salt, IV and ciphertext on each run', async () => {
    const first = await runLearningEncryption('hi');
    const second = await runLearningEncryption('hi');
    for (const field of ['alicePrivateHex', 'bobPrivateHex', 'sharedSecretHex', 'aliceToBobKeyHex', 'bobToAliceKeyHex', 'hkdfSaltHex', 'ivHex', 'combinedCiphertextHex'] as const) {
      expect(first[field]).not.toBe(second[field]);
    }
  });

  it('preserves Unicode and counts UTF-8 bytes without silently trimming the message', async () => {
    const text = ' hi 👋 नमस्ते ';
    const result = await runLearningEncryption(text);
    expect(result.plaintext).toBe(text);
    expect(result.decrypted).toBe(text);
    expect(result.plaintextBytes).toBe(encoder.encode(text).length);
    expect(result.ciphertextHex.length).toBe(result.plaintextBytes * 2);
    await expect(runLearningEncryption('a'.repeat(LEARNING_MAX_BYTES))).resolves.toMatchObject({ plaintextBytes: LEARNING_MAX_BYTES });
  });

  it('rejects empty and oversized input before generating demonstration material', async () => {
    await expect(runLearningEncryption('')).rejects.toThrow(/1 and 512 UTF-8 bytes/);
    await expect(runLearningEncryption('a'.repeat(LEARNING_MAX_BYTES + 1))).rejects.toThrow(/1 and 512 UTF-8 bytes/);
    await expect(runLearningEncryption('👋'.repeat(129))).rejects.toThrow(/1 and 512 UTF-8 bytes/);
    await expect(runLearningEncryption(null as unknown as string)).rejects.toThrow(/Enter a message/);
  });

  it('rejects tampered ciphertext, tag and authenticated context with the real displayed key', async () => {
    const result = await runLearningEncryption('hi');
    const key = await crypto.subtle.importKey('raw', fromHex(result.aliceToBobKeyHex), 'AES-GCM', false, ['decrypt']);
    const original = fromHex(result.combinedCiphertextHex);
    const parameters = { name: 'AES-GCM', iv: fromHex(result.ivHex), tagLength: 128, additionalData: encoder.encode(result.aad) };
    const changedCiphertext = original.slice();
    changedCiphertext[0] ^= 1;
    const changedTag = original.slice();
    changedTag[changedTag.length - 1] ^= 1;
    await expect(crypto.subtle.decrypt(parameters, key, changedCiphertext)).rejects.toThrow();
    await expect(crypto.subtle.decrypt(parameters, key, changedTag)).rejects.toThrow();
    await expect(crypto.subtle.decrypt({ ...parameters, additionalData: encoder.encode('different context') }, key, original)).rejects.toThrow();
  });
});
