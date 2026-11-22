export const E2EE_VERSION = 'e2ee-v1' as const;
export const E2EE_KEY_ALGORITHM = 'ECDH-P256' as const;
export const E2EE_MESSAGE_ALGORITHM = 'AES-256-GCM' as const;
export const MAX_ENCRYPTED_PLAINTEXT_BYTES = 4_096;

const DATABASE_NAME = 'qkd-chat-e2ee';
const DATABASE_VERSION = 1;
const STORE_NAME = 'room-identities';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;
const IV_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const MAX_IV_GENERATION_ATTEMPTS = 16;
const memoryIdentities = new Map<string, CryptoKeyPair>();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PAIR_KEY_ID_LABEL = encoder.encode('QKD-CHAT-E2EE-PAIR-KEY-ID-v1\0');
const usedSendIvs = new WeakMap<CryptoKey, Set<string>>();

export interface E2eeIdentity {
  keyPair: CryptoKeyPair;
  publicKey: string;
  publicKeyBytes: Uint8Array<ArrayBuffer>;
  publicKeyId: string;
  storage: 'device' | 'session';
}

export interface E2eeContext {
  keyId: string;
  localPublicKey: string;
  localPublicKeyId: string;
  peerPublicKey: string;
  peerPublicKeyId: string;
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
  verificationCode: string;
}

export interface Bb84ControlKeys {
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
  runId: Uint8Array<ArrayBuffer>;
}

export interface Bb84EpochKeys {
  context: E2eeContext;
  confirmationKey: CryptoKey;
}

export interface EncryptedPayload {
  version: typeof E2EE_VERSION;
  keyId: string;
  senderKeyId: string;
  iv: string;
  ciphertext: string;
}

export interface MessageBinding {
  roomId: string;
  senderId: string;
  senderName: string;
  clientMessageId: string;
  senderKeyId: string;
  keyId: string;
}

function webCrypto(): Crypto {
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error('Web Crypto is unavailable in this browser context.');
  }
  return crypto;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await webCrypto().subtle.digest('SHA-256', bytes));
}

async function exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array(await webCrypto().subtle.exportKey('raw', publicKey));
  if (raw.byteLength !== 65 || raw[0] !== 0x04) {
    throw new Error('The browser returned an invalid P-256 public key.');
  }
  return raw;
}

async function openIdentityDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Could not open key storage.'));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'scope' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readStoredKeyPair(scope: string): Promise<CryptoKeyPair | null> {
  const database = await openIdentityDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(scope);
      request.onerror = () => reject(request.error ?? new Error('Could not read key storage.'));
      request.onsuccess = () => {
        const record = request.result as { keyPair?: CryptoKeyPair } | undefined;
        resolve(record?.keyPair ?? null);
      };
    });
  } finally {
    database.close();
  }
}

async function storeKeyPair(scope: string, keyPair: CryptoKeyPair): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not store key.'));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(STORE_NAME).put({ scope, keyPair, createdAt: new Date().toISOString() });
    });
  } finally {
    database.close();
  }
}

export async function generateIdentity(): Promise<E2eeIdentity> {
  const keyPair = await webCrypto().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  ) as CryptoKeyPair;
  return identityFromKeyPair(keyPair, 'session');
}

async function identityFromKeyPair(
  keyPair: CryptoKeyPair,
  storage: E2eeIdentity['storage'],
): Promise<E2eeIdentity> {
  const publicKeyBytes = await exportPublicKey(keyPair.publicKey);
  const publicKey = bytesToBase64Url(publicKeyBytes);
  const publicKeyId = bytesToBase64Url(await sha256(publicKeyBytes));
  return { keyPair, publicKey, publicKeyBytes, publicKeyId, storage };
}

export async function getOrCreateIdentity(scope: string): Promise<E2eeIdentity> {
  const cleanScope = scope.trim();
  if (!cleanScope) throw new Error('An encryption identity scope is required.');

  const inMemory = memoryIdentities.get(cleanScope);
  if (inMemory) return identityFromKeyPair(inMemory, 'session');

  try {
    const stored = await readStoredKeyPair(cleanScope);
    if (stored) return await identityFromKeyPair(stored, 'device');
    const generated = await webCrypto().subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    ) as CryptoKeyPair;
    await storeKeyPair(cleanScope, generated);
    return await identityFromKeyPair(generated, 'device');
  } catch {
    const existing = memoryIdentities.get(cleanScope);
    if (existing) return identityFromKeyPair(existing, 'session');
    const generated = await webCrypto().subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    ) as CryptoKeyPair;
    memoryIdentities.set(cleanScope, generated);
    return identityFromKeyPair(generated, 'session');
  }
}

export async function rotateIdentity(scope: string): Promise<E2eeIdentity> {
  const cleanScope = scope.trim();
  if (!cleanScope) throw new Error('An encryption identity scope is required.');

  const generated = await webCrypto().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  ) as CryptoKeyPair;
  try {
    await storeKeyPair(cleanScope, generated);
    memoryIdentities.delete(cleanScope);
    return await identityFromKeyPair(generated, 'device');
  } catch {
    // Prefer the newly rotated key in this page even when durable browser
    // storage is blocked. Loading an older stored key after an IV-reuse
    // incident would recreate the key/nonce risk that rotation must remove.
    memoryIdentities.set(cleanScope, generated);
    return identityFromKeyPair(generated, 'session');
  }
}

export function isValidKeyIdentifier(value: string): boolean {
  return KEY_ID_PATTERN.test(value);
}

export function isValidPublicKeyEnvelope(publicKey: string, publicKeyId: string): boolean {
  return PUBLIC_KEY_PATTERN.test(publicKey) && KEY_ID_PATTERN.test(publicKeyId);
}

async function pairTranscriptHash(
  roomId: string,
  publicKeys: [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>],
): Promise<Uint8Array<ArrayBuffer>> {
  const orderedKeys = [...publicKeys].sort(compareBytes);
  const roomBytes = encoder.encode(roomId);
  if (roomBytes.byteLength === 0 || roomBytes.byteLength > 65_535) {
    throw new Error('The room identifier is outside the supported length.');
  }
  for (const key of orderedKeys) {
    if (key.byteLength !== 65 || key[0] !== 0x04) {
      throw new Error('The pair identifier requires raw P-256 public keys.');
    }
  }
  const roomLength = new Uint8Array(2);
  new DataView(roomLength.buffer).setUint16(0, roomBytes.byteLength, false);
  return sha256(concatBytes(
    PAIR_KEY_ID_LABEL,
    roomLength,
    roomBytes,
    orderedKeys[0],
    orderedKeys[1],
  ));
}

/** Derive fresh, directional control keys for one BB84 run from browser ECDH. */
export async function deriveBb84ControlKeys(
  identity: E2eeIdentity,
  peerPublicKey: string,
  roomId: string,
  pairKeyId: string,
  runId: Uint8Array,
): Promise<Bb84ControlKeys> {
  if (runId.byteLength !== 16) throw new Error('BB84 run IDs must contain 16 random bytes.');
  const peerBytes = base64UrlToBytes(peerPublicKey);
  if (peerBytes.byteLength !== 65 || peerBytes[0] !== 0x04) {
    throw new Error('The peer public key is not a P-256 uncompressed point.');
  }
  const peerId = bytesToBase64Url(await sha256(peerBytes));
  if (!isValidPublicKeyEnvelope(peerPublicKey, peerId)) {
    throw new Error('The peer public key is invalid.');
  }
  const expectedPairHash = await pairTranscriptHash(roomId, [identity.publicKeyBytes, peerBytes]);
  if (!constantTimeEqual(expectedPairHash, base64UrlToBytes(pairKeyId))) {
    throw new Error('The BB84 control key pair does not match the active room keys.');
  }
  const importedPeerKey = await webCrypto().subtle.importKey(
    'raw', peerBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const sharedSecret = new Uint8Array(await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: importedPeerKey },
    identity.keyPair.privateKey,
    256,
  ));
  try {
    const inputKey = await webCrypto().subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    const salt = await sha256(concatBytes(
      encoder.encode('bb84-endpoint-v1/control-salt\0'),
      base64UrlToBytes(pairKeyId),
      runId,
    ));
    const derive = (direction: 'low-to-high' | 'high-to-low') => webCrypto().subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: encoder.encode(`bb84-endpoint-v1/control/${direction}`),
      },
      inputKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const [lowToHigh, highToLow] = await Promise.all([derive('low-to-high'), derive('high-to-low')]);
    const localIsLow = compareBytes(identity.publicKeyBytes, peerBytes) < 0;
    return {
      sendKey: localIsLow ? lowToHigh : highToLow,
      receiveKey: localIsLow ? highToLow : lowToHigh,
      runId: new Uint8Array(runId),
    };
  } finally {
    sharedSecret.fill(0);
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function computePairKeyId(
  roomId: string,
  leftPublicKey: string,
  rightPublicKey: string,
): Promise<string> {
  return bytesToBase64Url(await pairTranscriptHash(roomId, [
    base64UrlToBytes(leftPublicKey),
    base64UrlToBytes(rightPublicKey),
  ]));
}

export async function deriveContext(
  identity: E2eeIdentity,
  peerPublicKey: string,
  peerPublicKeyId: string,
  roomId: string,
): Promise<E2eeContext> {
  if (!isValidPublicKeyEnvelope(peerPublicKey, peerPublicKeyId)) {
    throw new Error('The peer public key envelope is invalid.');
  }
  const peerBytes = base64UrlToBytes(peerPublicKey);
  if (peerBytes.byteLength !== 65 || peerBytes[0] !== 0x04) {
    throw new Error('The peer public key is not a P-256 uncompressed point.');
  }
  const calculatedPeerId = bytesToBase64Url(await sha256(peerBytes));
  if (calculatedPeerId !== peerPublicKeyId) {
    throw new Error('The peer public key identifier does not match the key.');
  }
  if (peerPublicKeyId === identity.publicKeyId) {
    throw new Error('The peer must use a different encryption identity.');
  }

  const importedPeerKey = await webCrypto().subtle.importKey(
    'raw',
    peerBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: importedPeerKey },
    identity.keyPair.privateKey,
    256,
  ));
  const orderedKeys = [identity.publicKeyBytes, peerBytes].sort(compareBytes);
  const transcriptHash = await pairTranscriptHash(roomId, [identity.publicKeyBytes, peerBytes]);
  const keyId = bytesToBase64Url(transcriptHash);
  const inputKey = await webCrypto().subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);

  const deriveDirectionalKey = (direction: 'low-to-high' | 'high-to-low') =>
    webCrypto().subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: transcriptHash,
        info: encoder.encode(`${E2EE_VERSION}/AES-256-GCM/${direction}`),
      },
      inputKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

  const lowToHighKey = await deriveDirectionalKey('low-to-high');
  const highToLowKey = await deriveDirectionalKey('high-to-low');
  const localIsLow = compareBytes(identity.publicKeyBytes, orderedKeys[0]) === 0;
  const verificationDigest = await sha256(concatBytes(
    encoder.encode(`${E2EE_VERSION}/verify\0`),
    transcriptHash,
    sharedSecret,
  ));
  const verificationNumber = Array.from(verificationDigest.slice(0, 6))
    .reduce((value, byte) => (value * 256n + BigInt(byte)) % 1_000_000_000_000n, 0n)
    .toString()
    .padStart(12, '0');

  sharedSecret.fill(0);

  return {
    keyId,
    localPublicKey: identity.publicKey,
    localPublicKeyId: identity.publicKeyId,
    peerPublicKey,
    peerPublicKeyId,
    sendKey: localIsLow ? lowToHighKey : highToLowKey,
    receiveKey: localIsLow ? highToLowKey : lowToHighKey,
    verificationCode: verificationNumber.match(/.{1,4}/g)?.join(' ') ?? verificationNumber,
  };
}

/**
 * Derive endpoint-only chat and confirmation keys from ECDH plus the locally
 * agreed 128-bit BB84 simulation output. This is still ECDH-dependent: the
 * software simulation is not a source of independent quantum security.
 */
export async function deriveBb84EpochKeys(
  identity: E2eeIdentity,
  base: E2eeContext,
  contribution: Uint8Array,
  preConfirmationTranscriptHash: Uint8Array,
): Promise<Bb84EpochKeys> {
  if (contribution.byteLength !== 16 || preConfirmationTranscriptHash.byteLength !== 32) {
    throw new Error('BB84 contribution or transcript hash has an invalid length.');
  }
  const peerBytes = base64UrlToBytes(base.peerPublicKey);
  const peer = await webCrypto().subtle.importKey(
    'raw', peerBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const sharedSecret = new Uint8Array(await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: peer }, identity.keyPair.privateKey, 256,
  ));
  const label = encoder.encode('bb84-endpoint-v1/chat-ikm\0');
  const lengthFields = new Uint8Array([0, sharedSecret.byteLength, 0, contribution.byteLength]);
  const ikm = concatBytes(label, lengthFields.subarray(0, 2), sharedSecret, lengthFields.subarray(2), contribution);
  sharedSecret.fill(0);
  try {
    const inputKey = await webCrypto().subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    const derive = (info: string, algorithm: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
      webCrypto().subtle.deriveKey({
        name: 'HKDF', hash: 'SHA-256', salt: preConfirmationTranscriptHash,
        info: encoder.encode(`bb84-endpoint-v1/${info}`),
      }, inputKey, algorithm, false, usages);
    const lowToHighKey = await derive('chat/low-to-high', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
    const highToLowKey = await derive('chat/high-to-low', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
    const confirmationKey = await derive('key-confirmation', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);
    const localIsLow = compareBytes(identity.publicKeyBytes, base64UrlToBytes(base.peerPublicKey)) < 0;
    return {
      context: {
        ...base,
        sendKey: localIsLow ? lowToHighKey : highToLowKey,
        receiveKey: localIsLow ? highToLowKey : lowToHighKey,
      },
      confirmationKey,
    };
  } finally {
    ikm.fill(0);
  }
}

export async function createBb84KeyConfirmation(
  key: CryptoKey,
  preConfirmationTranscriptHash: Uint8Array,
  role: 'alice' | 'bob',
  purpose: 'confirm' | 'ack' = 'confirm',
): Promise<Uint8Array<ArrayBuffer>> {
  const roleLabel = encoder.encode(`bb84-endpoint-v1/key-confirmation/${purpose}/${role}\0`);
  return new Uint8Array(await webCrypto().subtle.sign(
    'HMAC', key, concatBytes(roleLabel, preConfirmationTranscriptHash),
  ));
}

function additionalData(binding: MessageBinding): Uint8Array<ArrayBuffer> {
  return encoder.encode([
    E2EE_VERSION,
    binding.roomId,
    binding.senderId,
    binding.senderName,
    binding.clientMessageId,
    binding.senderKeyId,
    binding.keyId,
  ].join('\n'));
}

export async function encryptText(
  context: E2eeContext,
  text: string,
  binding: Omit<MessageBinding, 'senderKeyId' | 'keyId'>,
): Promise<EncryptedPayload> {
  const plaintext = encoder.encode(text);
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_ENCRYPTED_PLAINTEXT_BYTES) {
    throw new Error(`Message must encode to 1-${MAX_ENCRYPTED_PLAINTEXT_BYTES} bytes.`);
  }
  const seenIvs = usedSendIvs.get(context.sendKey) ?? new Set<string>();
  usedSendIvs.set(context.sendKey, seenIvs);
  let ivBytes: Uint8Array<ArrayBuffer> | null = null;
  let iv: string | null = null;
  for (let attempt = 0; attempt < MAX_IV_GENERATION_ATTEMPTS; attempt += 1) {
    const candidateBytes = webCrypto().getRandomValues(new Uint8Array(12));
    const candidate = bytesToBase64Url(candidateBytes);
    if (!seenIvs.has(candidate)) {
      ivBytes = candidateBytes;
      iv = candidate;
      break;
    }
  }
  if (!ivBytes || !iv) {
    throw new Error('Could not generate a unique AES-GCM IV.');
  }
  seenIvs.add(iv);
  const completeBinding: MessageBinding = {
    ...binding,
    senderKeyId: context.localPublicKeyId,
    keyId: context.keyId,
  };
  const ciphertext = new Uint8Array(await webCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: additionalData(completeBinding),
      tagLength: 128,
    },
    context.sendKey,
    plaintext,
  ));
  return {
    version: E2EE_VERSION,
    keyId: context.keyId,
    senderKeyId: context.localPublicKeyId,
    iv,
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

export async function decryptText(
  context: E2eeContext,
  payload: EncryptedPayload,
  binding: Omit<MessageBinding, 'senderKeyId' | 'keyId'>,
): Promise<string> {
  if (
    payload.version !== E2EE_VERSION
    || payload.keyId !== context.keyId
    || !KEY_ID_PATTERN.test(payload.senderKeyId)
    || !IV_PATTERN.test(payload.iv)
  ) {
    throw new Error('The encrypted message envelope does not match this session.');
  }
  const iv = base64UrlToBytes(payload.iv);
  const ciphertext = base64UrlToBytes(payload.ciphertext);
  if (iv.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > 4_112) {
    throw new Error('The encrypted message size is invalid.');
  }
  const key = payload.senderKeyId === context.localPublicKeyId
    ? context.sendKey
    : payload.senderKeyId === context.peerPublicKeyId
      ? context.receiveKey
      : null;
  if (!key) throw new Error('The encrypted message came from an unknown key.');

  const completeBinding: MessageBinding = {
    ...binding,
    senderKeyId: payload.senderKeyId,
    keyId: payload.keyId,
  };
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: additionalData(completeBinding),
      tagLength: 128,
    },
    key,
    ciphertext,
  );
  return decoder.decode(plaintext);
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return payload.version === E2EE_VERSION
    && typeof payload.keyId === 'string'
    && KEY_ID_PATTERN.test(payload.keyId)
    && typeof payload.senderKeyId === 'string'
    && KEY_ID_PATTERN.test(payload.senderKeyId)
    && typeof payload.iv === 'string'
    && IV_PATTERN.test(payload.iv)
    && typeof payload.ciphertext === 'string'
    && payload.ciphertext.length >= 23
    && payload.ciphertext.length <= 5_483
    && /^[A-Za-z0-9_-]+$/.test(payload.ciphertext);
}
