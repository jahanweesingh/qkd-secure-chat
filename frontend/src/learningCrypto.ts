/**
 * Visible-key classroom exercise. These disposable values never enter a chat,
 * a network request, browser storage, or the production encryption module.
 * Both modeled participants run in this browser; this is not a remote exchange.
 */
export const LEARNING_MAX_BYTES = 512;

export interface LearningEncryptionResult {
  plaintext: string;
  decrypted: string;
  plaintextBytes: number;
  ciphertextHex: string;
  tagHex: string;
  combinedCiphertextHex: string;
  ivHex: string;
  alicePrivateHex: string;
  bobPrivateHex: string;
  alicePublicHex: string;
  bobPublicHex: string;
  sharedSecretHex: string;
  aliceToBobKeyHex: string;
  bobToAliceKeyHex: string;
  hkdfSaltHex: string;
  aliceToBobInfo: string;
  bobToAliceInfo: string;
  aad: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DEMO_CONTEXT = 'QKD-CHAT-LEARNING-ONLY-v1';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function privateScalar(jwk: JsonWebKey): string {
  if (!jwk.d || !/^[A-Za-z0-9_-]{43}$/.test(jwk.d)) {
    throw new Error('The browser could not export a demonstration private key.');
  }
  const decoded = atob(`${jwk.d.replace(/-/g, '+').replace(/_/g, '/')}=`);
  return hex(Uint8Array.from(decoded, character => character.charCodeAt(0)));
}

/** Each invocation uses two new identities, a new salt and a new 96-bit IV. */
export async function runLearningEncryption(text: string): Promise<LearningEncryptionResult> {
  if (typeof text !== 'string') throw new Error('Enter a message for the demonstration.');
  const plaintextBytes = encoder.encode(text);
  if (plaintextBytes.length === 0 || plaintextBytes.length > LEARNING_MAX_BYTES) {
    throw new Error(`Use between 1 and ${LEARNING_MAX_BYTES} UTF-8 bytes for this demonstration.`);
  }
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error('This browser needs Web Crypto to run the demonstration.');
  }
  const { subtle } = crypto;
  const [alice, bob] = await Promise.all([
    subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  ]);
  const [alicePublic, bobPublic, alicePrivate, bobPrivate, aliceSecret, bobSecret] = await Promise.all([
    subtle.exportKey('raw', alice.publicKey),
    subtle.exportKey('raw', bob.publicKey),
    subtle.exportKey('jwk', alice.privateKey),
    subtle.exportKey('jwk', bob.privateKey),
    subtle.deriveBits({ name: 'ECDH', public: bob.publicKey }, alice.privateKey, 256),
    subtle.deriveBits({ name: 'ECDH', public: alice.publicKey }, bob.privateKey, 256),
  ]);
  if (!sameBytes(new Uint8Array(aliceSecret), new Uint8Array(bobSecret))) {
    throw new Error('The demonstration shared secrets did not match.');
  }
  const alicePublicHex = hex(new Uint8Array(alicePublic));
  const bobPublicHex = hex(new Uint8Array(bobPublic));
  const transcript = `${alicePublicHex}|${bobPublicHex}`;
  const aliceToBobInfo = `${DEMO_CONTEXT}|Alice->Bob|${transcript}`;
  const bobToAliceInfo = `${DEMO_CONTEXT}|Bob->Alice|${transcript}`;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const [aliceMaterial, bobMaterial] = await Promise.all([
    subtle.importKey('raw', aliceSecret, 'HKDF', false, ['deriveKey']),
    subtle.importKey('raw', bobSecret, 'HKDF', false, ['deriveKey']),
  ]);
  const derive = (material: CryptoKey, info: string) => subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    true, // Intentionally inspectable classroom keys; never production chat keys.
    ['encrypt', 'decrypt'],
  );
  const [aliceSend, bobReceive, bobSend, aliceReceive] = await Promise.all([
    derive(aliceMaterial, aliceToBobInfo),
    derive(bobMaterial, aliceToBobInfo),
    derive(bobMaterial, bobToAliceInfo),
    derive(aliceMaterial, bobToAliceInfo),
  ]);
  const [aliceSendBytes, bobReceiveBytes, bobSendBytes, aliceReceiveBytes] = await Promise.all(
    [aliceSend, bobReceive, bobSend, aliceReceive]
      .map(async key => new Uint8Array(await subtle.exportKey('raw', key))),
  );
  if (!sameBytes(aliceSendBytes, bobReceiveBytes) || !sameBytes(bobSendBytes, aliceReceiveBytes)
    || sameBytes(aliceSendBytes, bobSendBytes)) {
    throw new Error('The demonstration directional keys did not match correctly.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = `${DEMO_CONTEXT}|Alice->Bob|single-browser-exercise`;
  const parameters = { name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 };
  const combined = new Uint8Array(await subtle.encrypt(parameters, aliceSend, plaintextBytes));
  const decrypted = decoder.decode(await subtle.decrypt(parameters, bobReceive, combined));
  if (decrypted !== text) throw new Error('The decrypted demonstration message did not match.');

  return {
    plaintext: text,
    decrypted,
    plaintextBytes: plaintextBytes.length,
    ciphertextHex: hex(combined.subarray(0, -16)),
    tagHex: hex(combined.subarray(-16)),
    combinedCiphertextHex: hex(combined),
    ivHex: hex(iv),
    alicePrivateHex: privateScalar(alicePrivate),
    bobPrivateHex: privateScalar(bobPrivate),
    alicePublicHex,
    bobPublicHex,
    sharedSecretHex: hex(new Uint8Array(aliceSecret)),
    aliceToBobKeyHex: hex(aliceSendBytes),
    bobToAliceKeyHex: hex(bobSendBytes),
    hkdfSaltHex: hex(salt),
    aliceToBobInfo,
    bobToAliceInfo,
    aad,
  };
}
