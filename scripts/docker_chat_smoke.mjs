const baseUrl = process.env.CHAT_BASE_URL || 'http://localhost:8080';
const wsBaseUrl = baseUrl.replace(/^http/, 'ws');
const roomId = `SMOKE-${String(Date.now()).slice(-8)}`;
const timeoutMs = 8_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const e2eeVersion = 'e2ee-v1';
const pairKeyIdLabel = encoder.encode('QKD-CHAT-E2EE-PAIR-KEY-ID-v1\0');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function compareBytes(left, right) {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value) {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function generateIdentity() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey),
  );
  assert(
    publicKeyBytes.byteLength === 65 && publicKeyBytes[0] === 0x04,
    'Web Crypto returned an invalid uncompressed P-256 public key',
  );
  return {
    keyPair,
    publicKeyBytes,
    publicKey: base64Url(publicKeyBytes),
    publicKeyId: base64Url(await sha256(publicKeyBytes)),
  };
}

async function pairTranscriptHash(leftPublicKey, rightPublicKey) {
  const ordered = [leftPublicKey, rightPublicKey].sort(compareBytes);
  const roomBytes = encoder.encode(roomId);
  const roomLength = new Uint8Array(2);
  new DataView(roomLength.buffer).setUint16(0, roomBytes.byteLength, false);
  return sha256(concatBytes(
    pairKeyIdLabel,
    roomLength,
    roomBytes,
    ordered[0],
    ordered[1],
  ));
}

async function deriveContext(identity, peer) {
  assert(
    base64Url(await sha256(peer.publicKeyBytes)) === peer.publicKeyId,
    'Peer public-key identifier did not match its raw key',
  );
  const importedPeerKey = await crypto.subtle.importKey(
    'raw',
    peer.publicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: importedPeerKey },
    identity.keyPair.privateKey,
    256,
  ));
  const orderedKeys = [identity.publicKeyBytes, peer.publicKeyBytes].sort(compareBytes);
  const transcriptHash = await pairTranscriptHash(
    identity.publicKeyBytes,
    peer.publicKeyBytes,
  );
  const keyId = base64Url(transcriptHash);
  const inputKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveKey'],
  );
  const deriveDirectionalKey = (direction) => crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: transcriptHash,
      info: encoder.encode(`${e2eeVersion}/AES-256-GCM/${direction}`),
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
    encoder.encode(`${e2eeVersion}/verify\0`),
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
    localPublicKeyId: identity.publicKeyId,
    peerPublicKeyId: peer.publicKeyId,
    sendKey: localIsLow ? lowToHighKey : highToLowKey,
    receiveKey: localIsLow ? highToLowKey : lowToHighKey,
    verificationCode: verificationNumber.match(/.{1,4}/g).join(' '),
  };
}

function additionalData(binding) {
  return encoder.encode([
    e2eeVersion,
    roomId,
    binding.senderId,
    binding.senderName,
    binding.clientMessageId,
    binding.senderKeyId,
    binding.keyId,
  ].join('\n'));
}

async function encryptText(context, text, binding, suppliedIv) {
  const ivBytes = suppliedIv ?? crypto.getRandomValues(new Uint8Array(12));
  const completeBinding = {
    ...binding,
    senderKeyId: context.localPublicKeyId,
    keyId: context.keyId,
  };
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: additionalData(completeBinding),
      tagLength: 128,
    },
    context.sendKey,
    encoder.encode(text),
  ));
  return {
    type: 'encrypted_message',
    client_message_id: binding.clientMessageId,
    version: e2eeVersion,
    algorithm: 'AES-256-GCM',
    key_id: context.keyId,
    iv: base64Url(ivBytes),
    ciphertext: base64Url(ciphertext),
  };
}

async function decryptMessage(context, message) {
  const key = message.sender_key_id === context.localPublicKeyId
    ? context.sendKey
    : message.sender_key_id === context.peerPublicKeyId
      ? context.receiveKey
      : null;
  assert(key, 'Encrypted broadcast used an unknown sender key');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(message.iv),
      additionalData: additionalData({
        senderId: message.sender_id,
        senderName: message.sender_name,
        clientMessageId: message.client_message_id,
        senderKeyId: message.sender_key_id,
        keyId: message.key_id,
      }),
      tagLength: 128,
    },
    key,
    fromBase64Url(message.ciphertext),
  );
  return decoder.decode(plaintext);
}

function assertCiphertextOnly(value, forbiddenPlaintexts, label) {
  const serialized = JSON.stringify(value);
  for (const plaintext of forbiddenPlaintexts) {
    assert(!serialized.includes(plaintext), `${label} exposed message plaintext`);
  }
}

function hello(identity) {
  return {
    type: 'e2ee_hello',
    version: e2eeVersion,
    algorithm: 'ECDH-P256',
    public_key_id: identity.publicKeyId,
    public_key: identity.publicKey,
  };
}

function socketUrl(clientId, displayName) {
  const url = new URL(`/ws/${roomId}`, wsBaseUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('display_name', displayName);
  return url;
}

function waitForEvent(socket, expectedType, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedType}`));
    }, timeoutMs);

    const onMessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.type === expectedType && predicate(payload)) {
        cleanup();
        resolve(payload);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket failed while waiting for ${expectedType}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

function waitForClose(socket, expectedCode) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for close code ${expectedCode}`));
    }, timeoutMs);
    const onClose = (event) => {
      cleanup();
      if (event.code !== expectedCode) {
        reject(new Error(`Expected close code ${expectedCode}, received ${event.code}`));
        return;
      }
      resolve(event);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('close', onClose);
  });
}

async function connect(clientId, displayName) {
  const socket = new WebSocket(socketUrl(clientId, displayName));
  const connected = waitForEvent(socket, 'connected');
  await connected;
  return socket;
}

const health = await fetch(`${baseUrl}/api/health`);
assert(health.ok, `Health endpoint returned ${health.status}`);

const [aliceIdentity, bobIdentity] = await Promise.all([
  generateIdentity(),
  generateIdentity(),
]);
const alice = await connect('smoke-alice', 'Alice');
const bob = await connect('smoke-bob', 'Bob');

const bb84AtAlice = waitForEvent(alice, 'bb84_result');
const bb84AtBob = waitForEvent(bob, 'bb84_result');
bob.send(JSON.stringify({
  type: 'bb84_start',
  qubit_count: 512,
  noise_probability: 0,
  intercept_probability: 0,
  sample_ratio: 0.25,
  qber_threshold: 0.11,
  seed: 7,
}));
const [aliceSimulation, bobSimulation] = await Promise.all([bb84AtAlice, bb84AtBob]);
assert(
  JSON.stringify(aliceSimulation) === JSON.stringify(bobSimulation),
  'Participants received different BB84 simulation results',
);
assert(aliceSimulation.started_by === 'smoke-bob', 'BB84 starter identity was incorrect');
assert(aliceSimulation.simulation_only === true, 'BB84 result omitted simulation-only status');
assert(aliceSimulation.chat_encryption_active === false, 'BB84 result incorrectly enabled encryption');
assert(aliceSimulation.metrics?.transmitted === 512, 'BB84 result had incorrect metrics');
assert(Array.isArray(aliceSimulation.trace), 'BB84 result omitted the public trace');
assert(aliceSimulation.trace.length <= 24, 'BB84 result exceeded the public trace limit');
assert(
  aliceSimulation.trace.every((row) => !('alice_bit' in row) && !('bob_bit' in row)),
  'BB84 public trace exposed raw bit values',
);
const processing = aliceSimulation.post_processing;
assert(processing?.version === 'phase3-post-processing-v1', 'Phase 3 report version was incorrect');
assert(processing.status === 'completed', 'Ideal Phase 3 teaching pipeline did not complete');
assert(processing.reason === 'completed', 'Completed Phase 3 report had the wrong reason');
assert(processing.input_bits === aliceSimulation.metrics.retained, 'Post-processing input did not match retained bits');
assert(processing.reconciliation?.verified === true, 'Reconciliation was not verified');
assert(processing.reconciliation?.remaining_errors === 0, 'Reconciliation left unresolved errors');
assert(processing.privacy_amplification?.security_margin_bits === 32, 'Privacy margin was incorrect');
assert(processing.privacy_amplification?.output_bits === 128, 'Toeplitz output length was incorrect');
assert(processing.confirmation?.passed === true, 'Key confirmation did not pass');
assert(processing.derivation?.output_bits === 256, 'HKDF output size was incorrect');
assert(processing.derivation?.context_bound === true, 'HKDF report was not context-bound');
assert(processing.derivation?.material_retained === false, 'Derived material was incorrectly retained');
assert(processing.key_material_exposed === false, 'Phase 3 report claimed key exposure');
assert(processing.key_used_for_chat === false, 'Phase 3 report incorrectly activated chat key use');
assert(processing.reproducible_teaching_run === true, 'Seeded run was not labelled reproducible');

const forbiddenSecretKeys = new Set([
  'alice_bits',
  'bob_bits',
  'candidate_bits',
  'reconciled_bits',
  'seed_bits',
  'toeplitz_seed',
  'confirmation_tag',
  'hkdf_salt',
  'derived_material',
  'derived_key',
]);
function assertSecretFree(value) {
  if (Array.isArray(value)) {
    value.forEach(assertSecretFree);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert(!forbiddenSecretKeys.has(key), `Public result exposed secret field ${key}`);
    assertSecretFree(nested);
  }
}
assertSecretFree(aliceSimulation);
assert(
  new TextEncoder().encode(JSON.stringify(aliceSimulation)).length < 8_192,
  'Phase 3 result exceeded the relay frame limit',
);

const aliceHelloAtAlice = waitForEvent(
  alice,
  'e2ee_public_key',
  (event) => event.client_id === 'smoke-alice',
);
const aliceHelloAtBob = waitForEvent(
  bob,
  'e2ee_public_key',
  (event) => event.client_id === 'smoke-alice',
);
alice.send(JSON.stringify(hello(aliceIdentity)));
const [aliceAdvertisementForAlice, aliceAdvertisementForBob] = await Promise.all([
  aliceHelloAtAlice,
  aliceHelloAtBob,
]);
assert(
  JSON.stringify(aliceAdvertisementForAlice) === JSON.stringify(aliceAdvertisementForBob),
  'Participants received different Alice public-key advertisements',
);

const bobHelloAtAlice = waitForEvent(
  alice,
  'e2ee_public_key',
  (event) => event.client_id === 'smoke-bob',
);
const bobHelloAtBob = waitForEvent(
  bob,
  'e2ee_public_key',
  (event) => event.client_id === 'smoke-bob',
);
bob.send(JSON.stringify(hello(bobIdentity)));
const [bobAdvertisementForAlice, bobAdvertisementForBob] = await Promise.all([
  bobHelloAtAlice,
  bobHelloAtBob,
]);
assert(
  JSON.stringify(bobAdvertisementForAlice) === JSON.stringify(bobAdvertisementForBob),
  'Participants received different Bob public-key advertisements',
);
assert(
  !('private_key' in aliceAdvertisementForBob) && !('private_key' in bobAdvertisementForAlice),
  'Public-key advertisement exposed private key material',
);

const alicePeer = {
  publicKeyBytes: fromBase64Url(bobAdvertisementForAlice.public_key),
  publicKeyId: bobAdvertisementForAlice.public_key_id,
};
const bobPeer = {
  publicKeyBytes: fromBase64Url(aliceAdvertisementForBob.public_key),
  publicKeyId: aliceAdvertisementForBob.public_key_id,
};
const [aliceContext, bobContext] = await Promise.all([
  deriveContext(aliceIdentity, alicePeer),
  deriveContext(bobIdentity, bobPeer),
]);
assert(aliceContext.keyId === bobContext.keyId, 'Browsers derived different pair key IDs');
assert(
  aliceContext.verificationCode === bobContext.verificationCode,
  'Browsers derived different safety codes',
);
assert(
  /^\d{4} \d{4} \d{4}$/.test(aliceContext.verificationCode),
  'Safety code was not a grouped 12-digit value',
);

const aliceClientMessageId = `alice-${Date.now()}`;
const aliceText = 'Hello Bob — Docker delivery check';
const aliceMessage = waitForEvent(
  alice,
  'encrypted_message',
  (event) => event.message?.client_message_id === aliceClientMessageId,
);
const bobMessage = waitForEvent(
  bob,
  'encrypted_message',
  (event) => event.message?.client_message_id === aliceClientMessageId,
);
const acknowledgement = waitForEvent(
  alice,
  'message_ack',
  (event) => event.client_message_id === aliceClientMessageId,
);

const aliceEnvelope = await encryptText(aliceContext, aliceText, {
  senderId: 'smoke-alice',
  senderName: 'Alice',
  clientMessageId: aliceClientMessageId,
});
assert(!('sender_key_id' in aliceEnvelope), 'Client envelope supplied trusted sender metadata');
alice.send(JSON.stringify(aliceEnvelope));

const [seenByAlice, seenByBob, ack] = await Promise.all([
  aliceMessage,
  bobMessage,
  acknowledgement,
]);
assert(
  JSON.stringify(seenByAlice) === JSON.stringify(seenByBob),
  'Participants received different Alice encrypted broadcasts',
);
assert(seenByAlice.message.kind === 'encrypted_message', 'Alice broadcast kind was incorrect');
assert(!('text' in seenByAlice.message), 'Alice encrypted broadcast contained a text field');
assert(
  seenByAlice.message.sender_key_id === aliceIdentity.publicKeyId,
  'Server did not bind Alice broadcast to her registered public key',
);
assert(
  await decryptMessage(aliceContext, seenByAlice.message) === aliceText,
  'Alice could not decrypt her authenticated echo',
);
assert(
  await decryptMessage(bobContext, seenByBob.message) === aliceText,
  'Bob could not decrypt Alice ciphertext',
);
assertCiphertextOnly(seenByAlice, [aliceText], 'Alice broadcast');
assertCiphertextOnly(ack, [aliceText], 'Alice acknowledgement');
assert(ack.message_id === seenByAlice.message.id, 'Acknowledgement ID did not match');
assert(typeof ack.message_id === 'string', 'Acknowledgement ID was not serialized as a string');
assert(ack.duplicate === false, 'First Alice envelope was incorrectly marked duplicate');

const duplicateAcknowledgement = waitForEvent(
  alice,
  'message_ack',
  (event) => event.client_message_id === aliceClientMessageId && event.duplicate === true,
);
alice.send(JSON.stringify(aliceEnvelope));
const duplicateAck = await duplicateAcknowledgement;
assert(
  duplicateAck.message_id === ack.message_id,
  'Idempotent encrypted retry did not acknowledge the original message',
);
assertCiphertextOnly(duplicateAck, [aliceText], 'Duplicate acknowledgement');

const typingAtAlice = waitForEvent(
  alice,
  'typing',
  (event) => event.client_id === 'smoke-bob' && event.is_typing === true,
);
bob.send(JSON.stringify({ type: 'typing', is_typing: true }));
await typingAtAlice;

const bobClientMessageId = `bob-${Date.now()}`;
const bobText = 'Hello Alice — return path confirmed';
const replyAtAlice = waitForEvent(
  alice,
  'encrypted_message',
  (event) => event.message?.client_message_id === bobClientMessageId,
);
const replyAtBob = waitForEvent(
  bob,
  'encrypted_message',
  (event) => event.message?.client_message_id === bobClientMessageId,
);
const bobAcknowledgement = waitForEvent(
  bob,
  'message_ack',
  (event) => event.client_message_id === bobClientMessageId,
);
const bobEnvelope = await encryptText(bobContext, bobText, {
  senderId: 'smoke-bob',
  senderName: 'Bob',
  clientMessageId: bobClientMessageId,
});
bob.send(JSON.stringify(bobEnvelope));
const [replySeenByAlice, replySeenByBob, replyAck] = await Promise.all([
  replyAtAlice,
  replyAtBob,
  bobAcknowledgement,
]);
assert(
  JSON.stringify(replySeenByAlice) === JSON.stringify(replySeenByBob),
  'Participants received different Bob encrypted broadcasts',
);
assert(!('text' in replySeenByAlice.message), 'Bob encrypted broadcast contained a text field');
assert(
  replySeenByAlice.message.sender_key_id === bobIdentity.publicKeyId,
  'Server did not bind Bob broadcast to his registered public key',
);
assert(
  await decryptMessage(aliceContext, replySeenByAlice.message) === bobText,
  'Alice could not decrypt Bob ciphertext',
);
assert(
  await decryptMessage(bobContext, replySeenByBob.message) === bobText,
  'Bob could not decrypt his authenticated echo',
);
assertCiphertextOnly(replySeenByAlice, [bobText], 'Bob broadcast');
assertCiphertextOnly(replyAck, [bobText], 'Bob acknowledgement');
assert(replyAck.message_id === replySeenByAlice.message.id, 'Reply acknowledgement did not match');
assert(replyAck.duplicate === false, 'First Bob envelope was incorrectly marked duplicate');

const downgradeClientMessageId = `downgrade-${Date.now()}`;
const downgradeText = 'plaintext downgrade must be rejected';
const downgradeRejected = waitForEvent(
  bob,
  'error',
  (event) => event.code === 'e2ee_required'
    && event.client_message_id === downgradeClientMessageId,
);
bob.send(JSON.stringify({
  type: 'message',
  text: downgradeText,
  client_message_id: downgradeClientMessageId,
}));
await downgradeRejected;

const reusedIvClientMessageId = `reused-iv-${Date.now()}`;
const ivReuseRejected = waitForEvent(
  alice,
  'error',
  (event) => event.code === 'e2ee_iv_reuse'
    && event.client_message_id === reusedIvClientMessageId,
);
alice.send(JSON.stringify({
  ...aliceEnvelope,
  client_message_id: reusedIvClientMessageId,
}));
await ivReuseRejected;

const pong = waitForEvent(alice, 'pong');
alice.send(JSON.stringify({ type: 'ping' }));
await pong;

const historyResponse = await fetch(
  `${baseUrl}/api/rooms/${roomId}/messages?limit=50`,
);
assert(historyResponse.ok, `History endpoint returned ${historyResponse.status}`);
const history = await historyResponse.json();
assert(history.e2ee_required === true, 'History did not retain the durable E2EE room lock');
const aliceHistory = history.messages.find(
  (message) => message.client_message_id === aliceClientMessageId,
);
const bobHistory = history.messages.find(
  (message) => message.client_message_id === bobClientMessageId,
);
assert(aliceHistory, 'Alice encrypted message was not persisted');
assert(bobHistory, 'Bob encrypted message was not persisted');
assert(
  history.messages.filter((message) => message.client_message_id === aliceClientMessageId).length === 1,
  'Idempotent encrypted retry created a duplicate history record',
);
assert(
  !history.messages.some((message) => message.client_message_id === downgradeClientMessageId),
  'Rejected plaintext downgrade was persisted',
);
assert(
  !history.messages.some((message) => message.client_message_id === reusedIvClientMessageId),
  'Rejected IV reuse was persisted',
);
assert(
  history.messages.every(
    (message) => message.kind === 'encrypted_message'
      && !('text' in message)
      && typeof message.ciphertext === 'string',
  ),
  'History contained a plaintext or malformed encrypted record',
);
assert(
  aliceHistory.ciphertext === aliceEnvelope.ciphertext
    && aliceHistory.iv === aliceEnvelope.iv
    && aliceHistory.key_id === aliceContext.keyId,
  'Alice history envelope differed from the accepted ciphertext',
);
assert(
  bobHistory.ciphertext === bobEnvelope.ciphertext
    && bobHistory.iv === bobEnvelope.iv
    && bobHistory.key_id === bobContext.keyId,
  'Bob history envelope differed from the accepted ciphertext',
);
assert(
  await decryptMessage(bobContext, aliceHistory) === aliceText,
  'Bob could not decrypt Alice ciphertext loaded from history',
);
assert(
  await decryptMessage(aliceContext, bobHistory) === bobText,
  'Alice could not decrypt Bob ciphertext loaded from history',
);
assertCiphertextOnly(history, [aliceText, bobText, downgradeText], 'History response');
assert(
  history.messages.every((message) => typeof message.id === 'string'),
  'History message IDs were not serialized as strings',
);

const third = new WebSocket(socketUrl('smoke-charlie', 'Charlie'));
const thirdClosed = waitForClose(third, 4403);
const roomFull = await waitForEvent(
  third,
  'error',
  (event) => event.code === 'room_full',
);
assert(roomFull.code === 'room_full', 'Third participant was not rejected');
await thirdClosed;

alice.close();
bob.close();
third.close();

console.log(
  JSON.stringify(
    {
      status: 'PASS',
      room_id: roomId,
      checks: [
        'frontend proxy health',
        'two WebSocket participants',
        'shared redacted BB84 and Phase 3 result through deployed Nginx stack',
        'reconciliation, privacy amplification, confirmation and derivation metrics',
        'no secret fields, retained key material or chat-key activation',
        'browser-equivalent P-256 ECDH through Web Crypto',
        'exact room-and-public-key pair transcript',
        'matching grouped 12-digit safety code',
        'directional HKDF-SHA-256 AES-256-GCM keys',
        'exact authenticated metadata and bidirectional decryption',
        'ciphertext-only encrypted broadcasts and REST history',
        'metadata-only acknowledgements and idempotent encrypted retry',
        'durable plaintext downgrade rejection',
        'directional AES-GCM IV reuse rejection',
        'typing event delivery',
        'ping and pong keepalive',
        'SQLite ciphertext persistence',
        'third participant rejected with code 4403',
      ],
    },
    null,
    2,
  ),
);
