import type {
  ChatMessage,
  JoinRoomInput,
  JoinRoomResult,
  NetworkStatus,
  Participant,
  RoomSnapshot,
} from './types';
import { isEncryptedPayload } from './e2ee';

const API_ROOT = '/api';
const REQUEST_TIMEOUT_MS = 10_000;
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LEGACY_ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LAN_INVITATION_PATTERN = /^QKD-[0-9A-HJKMNPQRSTVWXYZ]{16}-([0-9A-HJKMNPQRSTVWXYZ]{7})$/;
const LAN_INVITATION_LIKE_PATTERN = /^QKD-[A-Z0-9]{16}-[A-Z0-9]{7}$/;

type JsonObject = Record<string, unknown>;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function firstString(source: JsonObject, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) return value;
  }
  return fallback;
}

export function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function encodePrivateIpv4(value: string): string | null {
  if (!isPrivateIpv4(value)) return null;
  const numeric = value
    .split('.')
    .map(Number)
    .reduce((total, octet) => total * 256 + octet, 0);
  let remaining = BigInt(numeric);
  let encoded = '';
  do {
    encoded = CROCKFORD_ALPHABET[Number(remaining % 32n)] + encoded;
    remaining /= 32n;
  } while (remaining > 0n);
  return encoded.padStart(7, '0');
}

function decodeCrockford(value: string): bigint | null {
  let numeric = 0n;
  for (const character of value) {
    const digit = CROCKFORD_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    numeric = numeric * 32n + BigInt(digit);
  }
  return numeric;
}

export function decodeInvitationHost(roomCode: string): string | null {
  const match = LAN_INVITATION_PATTERN.exec(normalizeRoomCode(roomCode));
  if (!match) return null;
  const numeric = decodeCrockford(match[1]);
  if (numeric === null || numeric < 0n || numeric > 0xFFFFFFFFn) return null;
  const octets = [
    Number((numeric >> 24n) & 0xFFn),
    Number((numeric >> 16n) & 0xFFn),
    Number((numeric >> 8n) & 0xFFn),
    Number(numeric & 0xFFn),
  ];
  const host = octets.join('.');
  return isPrivateIpv4(host) ? host : null;
}

export function isLanInvitationCode(roomCode: string): boolean {
  return LAN_INVITATION_LIKE_PATTERN.test(normalizeRoomCode(roomCode));
}

export function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeRoomCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64);
}

export function createRoomCode(
  advertisedHost?: string | null,
  mode: NetworkStatus['mode'] = 'localhost',
): string {
  const hosted = mode === 'hosted';
  const encodedHost = !hosted && advertisedHost ? encodePrivateIpv4(advertisedHost) : null;
  const bytes = new Uint8Array(hosted || encodedHost ? 16 : 6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else if (hosted) {
    throw new ApiError('Secure room-code generation is unavailable. Open this website over HTTPS in a current browser.');
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const randomAlphabet = hosted || encodedHost ? CROCKFORD_ALPHABET : LEGACY_ROOM_ALPHABET;
  const code = Array.from(bytes, (byte) => randomAlphabet[byte % randomAlphabet.length]).join('');
  return encodedHost ? `QKD-${code}-${encodedHost}` : `QKD-${code}`;
}

export function normalizeMessage(value: unknown, fallbackIndex = 0): ChatMessage | null {
  if (!isObject(value)) return null;
  const outerEventType = firstString(value, ['type', 'event', 'event_type']).toLowerCase();
  const nested = isObject(value.message) ? value.message : value;
  const text = firstString(nested, ['text', 'content', 'body']);
  const kindValue = firstString(nested, ['kind', 'message_type', 'type']);
  const kind = kindValue === 'system' ? 'system' : 'message';
  const encryptionFields = [
    'version',
    'algorithm',
    'key_id',
    'keyId',
    'sender_key_id',
    'senderKeyId',
    'iv',
    'ciphertext',
  ];
  const encryptionClaimed = outerEventType === 'encrypted_message'
    || kindValue === 'encrypted_message'
    || encryptionFields.some((field) => Object.prototype.hasOwnProperty.call(nested, field));
  const encryptedCandidate = {
    version: firstString(nested, ['version']),
    keyId: firstString(nested, ['key_id', 'keyId']),
    senderKeyId: firstString(nested, ['sender_key_id', 'senderKeyId']),
    iv: firstString(nested, ['iv']),
    ciphertext: firstString(nested, ['ciphertext']),
  };
  const encryption = firstString(nested, ['algorithm']) === 'AES-256-GCM'
    && isEncryptedPayload(encryptedCandidate)
    ? { ...encryptedCandidate, algorithm: 'AES-256-GCM' as const }
    : undefined;
  // An event that claims to be encrypted must contain one complete, valid
  // envelope. Never reinterpret malformed ciphertext as readable text.
  if (encryptionClaimed && !encryption) return null;
  if (!text && kind !== 'system' && !encryption) return null;

  const sender = isObject(nested.sender) ? nested.sender : {};
  const senderId = firstString(
    nested,
    ['sender_id', 'senderId', 'client_id', 'clientId', 'user_id'],
    firstString(sender, ['id', 'client_id'], 'unknown'),
  );
  const senderName = firstString(
    nested,
    ['sender_name', 'senderName', 'display_name', 'displayName', 'name'],
    firstString(sender, ['name', 'display_name'], kind === 'system' ? 'System' : 'Guest'),
  );
  const id = firstString(
    nested,
    ['id', 'message_id', 'messageId'],
    `history-${fallbackIndex}-${senderId}-${(text || encryptedCandidate.ciphertext).slice(0, 12)}`,
  );
  const clientMessageId = firstString(nested, ['client_message_id', 'clientMessageId']);
  if (encryption && !clientMessageId) return null;

  return {
    id,
    clientMessageId: clientMessageId || undefined,
    senderId,
    senderName,
    text: encryption ? 'Decrypting message…' : text,
    sentAt: firstString(nested, ['sent_at', 'sentAt', 'timestamp', 'created_at'], new Date().toISOString()),
    kind,
    status: 'sent',
    security: encryption
      ? 'decrypting'
      : kind === 'message'
        ? 'legacy_plaintext'
        : undefined,
    encryption,
  };
}

export function normalizeParticipant(value: unknown, fallbackIndex = 0): Participant | null {
  if (!isObject(value)) return null;
  const name = firstString(value, ['name', 'display_name', 'displayName']);
  if (!name) return null;
  return {
    id: firstString(value, ['id', 'client_id', 'clientId', 'user_id'], `guest-${fallbackIndex}`),
    name,
    online: typeof value.online === 'boolean' ? value.online : true,
    joinedAt: firstString(value, ['joined_at', 'joinedAt']) || undefined,
  };
}

function normalizeSnapshot(payload: unknown): RoomSnapshot {
  if (!isObject(payload)) return { messages: [], participants: [] };
  const rawMessages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.history)
      ? payload.history
      : [];
  const rawParticipants = Array.isArray(payload.participants)
    ? payload.participants
    : Array.isArray(payload.members)
      ? payload.members
      : [];
  return {
    messages: rawMessages
      .map((message, index) => normalizeMessage(message, index))
      .filter((message): message is ChatMessage => message !== null),
    participants: rawParticipants
      .map((participant, index) => normalizeParticipant(participant, index))
      .filter((participant): participant is Participant => participant !== null),
    e2eeRequired: payload.e2ee_required === true,
  };
}

async function requestJson(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    let body: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    }
    if (!response.ok) {
      const detail = isObject(body)
        ? firstString(body, ['detail', 'message', 'error'])
        : '';
      throw new ApiError(detail || `Request failed with status ${response.status}`, response.status);
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('The server took too long to respond. Please try again.');
    }
    throw new ApiError('Could not reach the chat server. Check that it is running and try again.');
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function joinRoom(input: JoinRoomInput): Promise<JoinRoomResult> {
  const requestedRoom = normalizeRoomCode(input.roomCode || createRoomCode());
  const invitationShape = isLanInvitationCode(requestedRoom);
  const invitationHost = decodeInvitationHost(requestedRoom);
  if (input.mode === 'join' && invitationShape && !invitationHost) {
    throw new ApiError('This LAN room code contains an invalid private network address. Ask the creator for a new code.');
  }
  const roomRoute = invitationHost
    ? input.mode === 'create' ? 'host' : 'partner'
    : 'local';
  let snapshot: RoomSnapshot = { messages: [], participants: [] };
  // The relayed WebSocket supplies the creator's authoritative history to a
  // joining Mac. Reading the guest's local database first could briefly show
  // stale messages that happen to use the same room code.
  if (roomRoute !== 'partner') {
    try {
      snapshot = await getRoomSnapshot(requestedRoom);
    } catch (error) {
      // A new room does not have durable history yet. Its WebSocket connection
      // creates the live room, so a history 404 is expected during create flow.
      if (!(input.mode === 'create' && error instanceof ApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  return {
    clientId: createClientId(),
    displayName: input.displayName.trim(),
    roomCode: requestedRoom,
    roomRoute,
    roomHost: invitationHost,
    ...snapshot,
  };
}

export async function getRoomSnapshot(
  roomCode: string,
): Promise<RoomSnapshot> {
  const payload = await requestJson(`/rooms/${encodeURIComponent(roomCode)}/messages?limit=50`);
  return normalizeSnapshot(payload);
}

export async function getHealth(): Promise<boolean> {
  await requestJson('/health');
  return true;
}

export async function getNetworkStatus(): Promise<NetworkStatus> {
  const payload = await requestJson('/network');
  if (!isObject(payload)
    || typeof payload.port !== 'number'
    || !Number.isInteger(payload.port)
    || payload.port < 1 || payload.port > 65_535) {
    throw new ApiError('The server returned an invalid connection mode. Retry the connection check.');
  }
  const advertisedHost = Object.prototype.hasOwnProperty.call(payload, 'advertised_host')
    ? payload.advertised_host : payload.advertisedHost;
  const conflictingHost = Object.prototype.hasOwnProperty.call(payload, 'advertisedHost')
    && payload.advertisedHost !== advertisedHost;
  if (payload.mode === 'hosted'
    && payload.advertised_host === null
    && !conflictingHost
    && payload.ready === true) {
    return { mode: 'hosted', advertisedHost: null, port: payload.port, ready: true };
  }
  if (payload.mode === 'lan' && payload.ready === true
    && !conflictingHost && typeof advertisedHost === 'string'
    && isPrivateIpv4(advertisedHost)
  ) {
    return { mode: 'lan', advertisedHost, port: payload.port, ready: true };
  }
  if (payload.mode === 'localhost' && payload.ready === false
    && !conflictingHost && advertisedHost === null) {
    return { mode: 'localhost', advertisedHost: null, port: payload.port, ready: false };
  }
  // Unknown or malformed deployment metadata must not become a weaker local room.
  throw new ApiError('The server returned an invalid connection mode. Retry the connection check.');
}

export function buildWebSocketUrl(session: {
  roomCode: string;
  clientId: string;
  displayName: string;
}): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const roomPath = encodeURIComponent(session.roomCode);
  const url = new URL(`/ws/${roomPath}`, `${protocol}//${window.location.host}`);
  url.searchParams.set('client_id', session.clientId);
  url.searchParams.set('display_name', session.displayName);
  return url.toString();
}

export function parseSocketPayload(payload: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readEventType(event: JsonObject): string {
  return firstString(event, ['type', 'event', 'event_type']).toLowerCase();
}

export function readString(event: JsonObject, keys: string[], fallback = ''): string {
  return firstString(event, keys, fallback);
}

export function readBoolean(event: JsonObject, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    if (typeof event[key] === 'boolean') return event[key];
  }
  return fallback;
}

export function readArray(event: JsonObject, keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(event[key])) return event[key];
  }
  return [];
}
