import { randomBytes } from 'node:crypto';

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const timeoutMs = Number.parseInt(process.env.DUAL_HOST_TIMEOUT_MS || '12000', 10);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
  throw new Error('DUAL_HOST_TIMEOUT_MS must be an integer between 1000 and 120000');
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const forbiddenProtocolKeys = new Set([
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
    assert(!forbiddenProtocolKeys.has(key), `Protocol result exposed secret field ${key}`);
    assertSecretFree(nested);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing required environment variable ${name}`);
  return value;
}

function parseBaseUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be a valid absolute HTTP URL; received ${JSON.stringify(value)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    fail(`${name} must use http:// or https://; received ${url.protocol}`);
  }
  if (url.username || url.password) fail(`${name} must not contain credentials`);
  return url;
}

function parsePrivateIpv4(value) {
  const rawOctets = value.split('.');
  if (
    rawOctets.length !== 4
    || rawOctets.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))
  ) {
    fail(`CREATOR_LAN_IP must be a canonical RFC1918 IPv4 address; received ${JSON.stringify(value)}`);
  }
  const octets = rawOctets.map(Number);
  if (octets.some((octet) => octet > 255)) {
    fail(`CREATOR_LAN_IP contains an octet above 255; received ${JSON.stringify(value)}`);
  }
  const isPrivate = octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
  if (!isPrivate) {
    fail(`CREATOR_LAN_IP must be in 10/8, 172.16/12, or 192.168/16; received ${value}`);
  }
  return octets;
}

function encodeIpv4(octets) {
  let value = 0n;
  for (const octet of octets) value = (value << 8n) | BigInt(octet);

  let encoded = '';
  do {
    encoded = CROCKFORD_ALPHABET[Number(value % 32n)] + encoded;
    value /= 32n;
  } while (value > 0n);
  return encoded.padStart(7, '0');
}

function createInvitation(creatorLanIp) {
  const randomPart = Array.from(
    randomBytes(16),
    (byte) => CROCKFORD_ALPHABET[byte & 31],
  ).join('');
  const encodedIpv4 = encodeIpv4(parsePrivateIpv4(creatorLanIp));
  const invitation = `QKD-${randomPart}-${encodedIpv4}`;
  assert(
    /^QKD-[0-9A-HJKMNPQRSTVWXYZ]{16}-[0-9A-HJKMNPQRSTVWXYZ]{7}$/.test(invitation),
    `Generated invitation has an unexpected shape: ${invitation}`,
  );
  return invitation;
}

function websocketUrl(baseUrl, roomId, clientId, displayName) {
  const url = new URL(`/ws/${encodeURIComponent(roomId)}`, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('display_name', displayName);
  return url;
}

async function getJson(label, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      fail(`${label} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      fail(`${label} did not return JSON: ${body.slice(0, 500)}`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      fail(`${label} timed out after ${timeoutMs} ms (${url})`);
    }
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} failed (${url}): ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

class SocketProbe {
  constructor(label, url) {
    this.label = label;
    this.url = url.toString();
    this.events = [];
    this.waiters = new Set();
    this.closed = null;
    this.socket = new WebSocket(url);

    this.socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        this.rejectWaiters(new Error(`${this.label} received a non-JSON WebSocket frame`));
        return;
      }
      this.events.push(payload);
      for (const waiter of [...this.waiters]) {
        let matched = false;
        try {
          matched = waiter.type === payload.type && waiter.predicate(payload);
        } catch (error) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.reject(
            new Error(
              `${this.label} could not validate ${waiter.description}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          continue;
        }
        if (matched) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(payload);
        }
      }
    });

    this.socket.addEventListener('error', () => {
      this.rejectWaiters(
        new Error(`${this.label} WebSocket failed while connecting to ${this.url}`),
      );
    });

    this.socket.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.rejectWaiters(
        new Error(
          `${this.label} WebSocket closed with code ${event.code}`
          + `${event.reason ? ` (${event.reason})` : ''} while an event was pending`,
        ),
      );
    });
  }

  rejectWaiters(error) {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  waitFor(type, predicate = () => true, description = type) {
    let existing;
    try {
      existing = this.events.find((event) => event.type === type && predicate(event));
    } catch (error) {
      return Promise.reject(
        new Error(
          `${this.label} could not validate ${description}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if (existing) return Promise.resolve(existing);
    if (this.closed) {
      return Promise.reject(
        new Error(
          `${this.label} was already closed with code ${this.closed.code}`
          + `${this.closed.reason ? ` (${this.closed.reason})` : ''}`
          + ` before ${description}`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, description, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const observed = this.events.map((event) => event.type || '<missing-type>').join(', ');
        reject(
          new Error(
            `${this.label} timed out after ${timeoutMs} ms waiting for ${description}; `
            + `observed event types: ${observed || 'none'}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  send(payload) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      fail(`${this.label} cannot send because its WebSocket state is ${this.socket.readyState}`);
    }
    this.socket.send(JSON.stringify(payload));
  }

  eventCounts() {
    return this.events.reduce((counts, event) => {
      const type = typeof event.type === 'string' ? event.type : '<missing-type>';
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {});
  }

  close() {
    this.rejectWaiters(new Error(`${this.label} was closed by the smoke test`));
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, 'smoke test complete');
    }
  }
}

const creatorBaseUrl = parseBaseUrl(
  'CREATOR_BASE_URL',
  requiredEnvironment('CREATOR_BASE_URL'),
);
const joinerBaseUrl = parseBaseUrl(
  'JOINER_BASE_URL',
  requiredEnvironment('JOINER_BASE_URL'),
);
assert(
  creatorBaseUrl.origin !== joinerBaseUrl.origin,
  'CREATOR_BASE_URL and JOINER_BASE_URL must identify two different local app endpoints',
);
const creatorLanIp = requiredEnvironment('CREATOR_LAN_IP');
const roomId = createInvitation(creatorLanIp);
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const aliceClientId = `dual-alice-${runId}`;
const bobClientId = `dual-bob-${runId}`;
const startedAt = performance.now();

let alice;
let bob;

try {
  const [creatorHealth, joinerHealth, creatorNetwork, joinerNetwork] = await Promise.all([
    getJson('Creator health check', new URL('/api/health', creatorBaseUrl)),
    getJson('Joiner health check', new URL('/api/health', joinerBaseUrl)),
    getJson('Creator network configuration', new URL('/api/network', creatorBaseUrl)),
    getJson('Joiner network configuration', new URL('/api/network', joinerBaseUrl)),
  ]);
  assert(creatorHealth.status === 'ok', 'Creator health response was not healthy');
  assert(joinerHealth.status === 'ok', 'Joiner health response was not healthy');
  assert(
    creatorNetwork.ready === true && creatorNetwork.advertised_host === creatorLanIp,
    'Creator is not advertising CREATOR_LAN_IP. Restart it with matching LAN_ADVERTISE_IP '
      + `(expected ${creatorLanIp}, received ${JSON.stringify(creatorNetwork)})`,
  );
  assert(
    joinerNetwork.advertised_host !== creatorLanIp,
    'Joiner is advertising the creator IP and would treat the invitation as a local room; '
      + 'configure each copy with its own LAN_ADVERTISE_IP',
  );

  alice = new SocketProbe(
    'Alice through creator',
    websocketUrl(creatorBaseUrl, roomId, aliceClientId, 'Alice'),
  );
  const [aliceConnected, aliceInitialPresence] = await Promise.all([
    alice.waitFor('connected', (event) => event.client_id === aliceClientId, 'Alice connected'),
    alice.waitFor(
      'presence',
      (event) => event.action === 'joined' && event.client_id === aliceClientId,
      'Alice initial presence',
    ),
  ]);
  assert(aliceConnected.room_id === roomId, 'Creator connected Alice to the wrong room');
  assert(
    aliceInitialPresence.participants?.some((participant) => participant.client_id === aliceClientId),
    'Alice was missing from creator presence state',
  );

  const bobPresenceAtAlice = alice.waitFor(
    'presence',
    (event) => event.action === 'joined' && event.client_id === bobClientId,
    'Bob presence at Alice',
  );
  bob = new SocketProbe(
    'Bob through joiner',
    websocketUrl(joinerBaseUrl, roomId, bobClientId, 'Bob'),
  );
  const [bobConnected, bobInitialPresence, bobSeenAtAlice] = await Promise.all([
    bob.waitFor('connected', (event) => event.client_id === bobClientId, 'Bob relayed connection'),
    bob.waitFor(
      'presence',
      (event) => event.action === 'joined' && event.client_id === bobClientId,
      'Bob initial presence',
    ),
    bobPresenceAtAlice,
  ]);
  for (const [label, event] of [
    ['Bob connected event', bobConnected],
    ['Bob presence event', bobInitialPresence],
    ['Alice presence event', bobSeenAtAlice],
  ]) {
    assert(
      event.participants?.some((participant) => participant.client_id === aliceClientId)
        && event.participants?.some((participant) => participant.client_id === bobClientId),
      `${label} did not contain both participants`,
    );
  }

  const protocolAtAlice = alice.waitFor(
    'bb84_result',
    (event) => event.started_by === bobClientId,
    'Phase 3 result at Alice',
  );
  const protocolAtBob = bob.waitFor(
    'bb84_result',
    (event) => event.started_by === bobClientId,
    'Phase 3 result through joiner',
  );
  bob.send({
    type: 'bb84_start',
    qubit_count: 512,
    noise_probability: 0,
    intercept_probability: 0,
    sample_ratio: 0.25,
    qber_threshold: 0.11,
    seed: 7,
  });
  const [aliceProtocol, bobProtocol] = await Promise.all([
    protocolAtAlice,
    protocolAtBob,
  ]);
  assert(
    JSON.stringify(aliceProtocol) === JSON.stringify(bobProtocol),
    'Creator and joiner received different protocol results',
  );
  assert(aliceProtocol.simulation_only === true, 'Protocol result omitted simulation status');
  assert(aliceProtocol.chat_encryption_active === false, 'Protocol result enabled chat encryption');
  assert(
    aliceProtocol.post_processing?.version === 'phase3-post-processing-v1',
    'Phase 3 report version was incorrect',
  );
  assert(
    aliceProtocol.post_processing?.status === 'completed',
    'Ideal Phase 3 relay experiment did not complete',
  );
  assert(
    aliceProtocol.post_processing?.privacy_amplification?.output_bits === 128,
    'Phase 3 relay experiment had the wrong Toeplitz output size',
  );
  assert(
    aliceProtocol.post_processing?.derivation?.output_bits === 256
      && aliceProtocol.post_processing?.derivation?.material_retained === false,
    'Phase 3 relay experiment had unsafe derivation metadata',
  );
  assert(aliceProtocol.post_processing?.key_material_exposed === false, 'Protocol key was exposed');
  assert(aliceProtocol.post_processing?.key_used_for_chat === false, 'Protocol key was used by chat');
  assertSecretFree(aliceProtocol);

  const aliceMessageId = `alice-${runId}`;
  const aliceText = `Alice to Bob dual-host check ${runId}`;
  const aliceOwnBroadcast = alice.waitFor(
    'message',
    (event) => event.message?.client_message_id === aliceMessageId,
    'Alice message broadcast at creator',
  );
  const aliceAtBob = bob.waitFor(
    'message',
    (event) => event.message?.client_message_id === aliceMessageId,
    'Alice message relayed to Bob',
  );
  const aliceAck = alice.waitFor(
    'message_ack',
    (event) => event.client_message_id === aliceMessageId,
    'Alice message acknowledgement',
  );
  alice.send({ type: 'message', text: aliceText, client_message_id: aliceMessageId });
  const [aliceBroadcast, aliceRelayed, aliceAcknowledgement] = await Promise.all([
    aliceOwnBroadcast,
    aliceAtBob,
    aliceAck,
  ]);
  assert(aliceBroadcast.message.text === aliceText, 'Creator changed Alice message text');
  assert(aliceRelayed.message.text === aliceText, 'Relay changed Alice message text');
  assert(
    aliceAcknowledgement.message_id === aliceBroadcast.message.id,
    'Alice acknowledgement ID did not match the persisted message',
  );

  const bobMessageId = `bob-${runId}`;
  const bobText = `Bob to Alice dual-host check ${runId}`;
  const bobAtAlice = alice.waitFor(
    'message',
    (event) => event.message?.client_message_id === bobMessageId,
    'Bob message relayed to Alice',
  );
  const bobOwnBroadcast = bob.waitFor(
    'message',
    (event) => event.message?.client_message_id === bobMessageId,
    'Bob message broadcast through joiner',
  );
  const bobAck = bob.waitFor(
    'message_ack',
    (event) => event.client_message_id === bobMessageId,
    'Bob message acknowledgement through joiner',
  );
  bob.send({ type: 'message', text: bobText, client_message_id: bobMessageId });
  const [bobRelayed, bobBroadcast, bobAcknowledgement] = await Promise.all([
    bobAtAlice,
    bobOwnBroadcast,
    bobAck,
  ]);
  assert(bobRelayed.message.text === bobText, 'Relay changed Bob message text');
  assert(bobBroadcast.message.text === bobText, 'Creator changed Bob message text');
  assert(
    bobAcknowledgement.message_id === bobRelayed.message.id,
    'Bob acknowledgement ID did not match the persisted message',
  );

  const bobTypingAtAlice = alice.waitFor(
    'typing',
    (event) => event.client_id === bobClientId && event.is_typing === true,
    'Bob typing at Alice',
  );
  bob.send({ type: 'typing', is_typing: true });
  await bobTypingAtAlice;

  const aliceTypingAtBob = bob.waitFor(
    'typing',
    (event) => event.client_id === aliceClientId && event.is_typing === true,
    'Alice typing at Bob',
  );
  alice.send({ type: 'typing', is_typing: true });
  await aliceTypingAtBob;

  const alicePong = alice.waitFor('pong', () => true, 'pong at Alice');
  alice.send({ type: 'ping' });
  await alicePong;

  const bobPong = bob.waitFor('pong', () => true, 'pong relayed to Bob');
  bob.send({ type: 'ping' });
  await bobPong;

  const history = await getJson(
    'Creator room history',
    new URL(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=50`, creatorBaseUrl),
  );
  assert(history.room_id === roomId, 'Creator returned history for the wrong room');
  assert(Array.isArray(history.messages), 'Creator history did not contain a messages array');
  const persistedAlice = history.messages.find(
    (message) => message.client_message_id === aliceMessageId,
  );
  const persistedBob = history.messages.find(
    (message) => message.client_message_id === bobMessageId,
  );
  assert(persistedAlice?.text === aliceText, 'Alice message was not persisted by creator');
  assert(persistedBob?.text === bobText, 'Bob message was not persisted by creator');
  assert(
    typeof persistedAlice.id === 'string' && typeof persistedBob.id === 'string',
    'Creator history message IDs were not serialized as strings',
  );

  const durationMs = Math.round(performance.now() - startedAt);
  console.log(JSON.stringify({
    status: 'PASS',
    test: 'dual-host LAN chat and Phase 3 relay',
    duration_ms: durationMs,
    room_id: roomId,
    creator: {
      base_url: creatorBaseUrl.origin,
      advertised_ip: creatorLanIp,
      event_counts: alice.eventCounts(),
    },
    joiner: {
      base_url: joinerBaseUrl.origin,
      advertised_ip: joinerNetwork.advertised_host ?? null,
      event_counts: bob.eventCounts(),
    },
    message_ids: {
      alice: aliceAcknowledgement.message_id,
      bob: bobAcknowledgement.message_id,
    },
    history_messages_verified: 2,
    checks: [
      'both local HTTP health endpoints',
      'creator LAN advertisement matches invitation',
      'Alice connected through creator local endpoint',
      'Bob connected through joiner local relay',
      'two-person presence synchronized across hosts',
      'guest-started Phase 3 result identical across both hosts',
      'post-processing report is redacted and not used by chat',
      'bidirectional messages and acknowledgements',
      'bidirectional typing indicators',
      'ping and pong through both paths',
      'authoritative creator history persistence',
    ],
  }, null, 2));
} finally {
  alice?.close();
  bob?.close();
}
