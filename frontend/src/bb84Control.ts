/** Opaque, browser-only AES-GCM control envelopes for the endpoint BB84 demo. */

import type { Bb84ControlKeys } from './e2ee';

export const BB84_CONTROL_VERSION = 'bb84-endpoint-v1' as const;
export const BB84_CONTROL_MAX_FRAME_BYTES = 4_096;
export const BB84_CONTROL_MAX_PLAINTEXT_BYTES = 2_048;
export const BB84_CONTROL_MAX_SEQUENCE = 65_535;

export interface Bb84ControlEnvelope {
  type: 'bb84_control';
  version: typeof BB84_CONTROL_VERSION;
  room_id: string;
  pair_key_id: string;
  run_id: string;
  sender_key_id: string;
  recipient_key_id: string;
  sequence: number;
  nonce: string;
  ciphertext: string;
}

export interface Bb84ControlExpectation {
  roomId: string;
  pairKeyId: string;
  runId: Uint8Array;
  senderKeyId: string;
  recipientKeyId: string;
  sequence: number;
}

export interface Bb84ControlPayload {
  kind: string;
  payload: Record<string, unknown>;
}

/** One run-local monotonic sender counter; counters must never be reset for the same keys. */
export class Bb84ControlSender {
  private nextSequence = 0;

  constructor(
    private readonly keys: Bb84ControlKeys,
    private readonly header: Omit<Bb84ControlExpectation, 'runId' | 'sequence'>,
  ) {}

  async seal(message: Bb84ControlPayload): Promise<Bb84ControlEnvelope> {
    if (this.nextSequence > BB84_CONTROL_MAX_SEQUENCE) throw new Error('BB84 control sequence is exhausted.');
    const sequence = this.nextSequence++;
    return encryptBb84Control(this.keys, this.header, sequence, message);
  }
}

/** Enforces ordered, single-use inbound sequence numbers before state handling. */
export class Bb84ControlReceiver {
  private nextSequence = 0;

  constructor(
    private readonly keys: Bb84ControlKeys,
    private readonly expectation: Omit<Bb84ControlExpectation, 'sequence'>,
  ) {}

  async open(envelope: unknown): Promise<Bb84ControlPayload> {
    const message = await decryptBb84Control(this.keys, envelope, {
      ...this.expectation,
      sequence: this.nextSequence,
    });
    this.nextSequence += 1;
    return message;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const ENVELOPE_FIELDS = [
  'type', 'version', 'room_id', 'pair_key_id', 'run_id', 'sender_key_id',
  'recipient_key_id', 'sequence', 'nonce', 'ciphertext',
].sort();
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ROOM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function encryptBb84Control(
  keys: Bb84ControlKeys,
  header: Omit<Bb84ControlExpectation, 'runId' | 'sequence'>,
  sequence: number,
  message: Bb84ControlPayload,
): Promise<Bb84ControlEnvelope> {
  validateHeaderValues(header, sequence);
  if (keys.runId.length !== 16) throw new Error('BB84 run ID is invalid.');
  if (typeof message.kind !== 'string' || !message.kind || message.kind.length > 32 || !isRecord(message.payload)) {
    throw new Error('BB84 control message shape is invalid.');
  }
  const plaintext = encoder.encode(JSON.stringify(message));
  if (plaintext.length > BB84_CONTROL_MAX_PLAINTEXT_BYTES) throw new Error('BB84 control payload is too large.');
  const runId = bytesToBase64Url(keys.runId);
  const nonce = nonceForSequence(sequence);
  const envelope: Bb84ControlEnvelope = {
    type: 'bb84_control',
    version: BB84_CONTROL_VERSION,
    room_id: header.roomId,
    pair_key_id: header.pairKeyId,
    run_id: runId,
    sender_key_id: header.senderKeyId,
    recipient_key_id: header.recipientKeyId,
    sequence,
    nonce: bytesToBase64Url(nonce),
    ciphertext: '',
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData(envelope), tagLength: 128 },
    keys.sendKey,
    plaintext,
  );
  envelope.ciphertext = bytesToBase64Url(new Uint8Array(ciphertext));
  if (encoder.encode(JSON.stringify(envelope)).length > BB84_CONTROL_MAX_FRAME_BYTES) {
    throw new Error('BB84 control envelope exceeds the frame limit.');
  }
  return envelope;
}

export async function decryptBb84Control(
  keys: Bb84ControlKeys,
  value: unknown,
  expected: Bb84ControlExpectation,
): Promise<Bb84ControlPayload> {
  const envelope = normalizeBb84ControlEnvelope(value);
  validateHeaderValues(expected, expected.sequence);
  if (expected.runId.length !== 16
    || envelope.room_id !== expected.roomId
    || envelope.pair_key_id !== expected.pairKeyId
    || envelope.run_id !== bytesToBase64Url(expected.runId)
    || envelope.run_id !== bytesToBase64Url(keys.runId)
    || envelope.sender_key_id !== expected.senderKeyId
    || envelope.recipient_key_id !== expected.recipientKeyId
    || envelope.sequence !== expected.sequence
    || !constantTimeTextEqual(envelope.nonce, bytesToBase64Url(nonceForSequence(expected.sequence)))) {
    throw new Error('BB84 control envelope does not match the active run state.');
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlToBytes(envelope.nonce),
      additionalData: associatedData(envelope),
      tagLength: 128,
    },
    keys.receiveKey,
    base64UrlToBytes(envelope.ciphertext),
  );
  if (plaintext.byteLength > BB84_CONTROL_MAX_PLAINTEXT_BYTES) throw new Error('BB84 control payload is too large.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('BB84 control plaintext is not valid UTF-8 JSON.');
  }
  if (!isRecord(decoded) || !hasExactKeys(decoded, ['kind', 'payload'])
    || typeof decoded.kind !== 'string' || !decoded.kind || decoded.kind.length > 32
    || !isRecord(decoded.payload)) {
    throw new Error('BB84 control plaintext has an invalid schema.');
  }
  return { kind: decoded.kind, payload: decoded.payload };
}

export function normalizeBb84ControlEnvelope(value: unknown): Bb84ControlEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_FIELDS)) {
    throw new Error('BB84 control envelope fields are invalid.');
  }
  const fields = value as Record<string, unknown>;
  if (fields.type !== 'bb84_control' || fields.version !== BB84_CONTROL_VERSION
    || typeof fields.room_id !== 'string' || !ROOM_PATTERN.test(fields.room_id)
    || typeof fields.pair_key_id !== 'string' || !ID_PATTERN.test(fields.pair_key_id)
    || typeof fields.run_id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(fields.run_id)
    || typeof fields.sender_key_id !== 'string' || !ID_PATTERN.test(fields.sender_key_id)
    || typeof fields.recipient_key_id !== 'string' || !ID_PATTERN.test(fields.recipient_key_id)
    || typeof fields.sequence !== 'number' || !Number.isInteger(fields.sequence)
    || fields.sequence < 0 || fields.sequence > BB84_CONTROL_MAX_SEQUENCE
    || typeof fields.nonce !== 'string' || typeof fields.ciphertext !== 'string') {
    throw new Error('BB84 control envelope values are invalid.');
  }
  const nonce = base64UrlToBytes(fields.nonce);
  const ciphertext = base64UrlToBytes(fields.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 16 || encoder.encode(JSON.stringify(value)).length > BB84_CONTROL_MAX_FRAME_BYTES) {
    throw new Error('BB84 control envelope size is invalid.');
  }
  return fields as unknown as Bb84ControlEnvelope;
}

function associatedData(envelope: Bb84ControlEnvelope): Uint8Array {
  const run = base64UrlToBytes(envelope.run_id);
  return concatBytes(
    encoder.encode(`${BB84_CONTROL_VERSION}/control-aad\0`),
    lengthPrefixed(encoder.encode(envelope.version)),
    lengthPrefixed(encoder.encode(envelope.room_id)),
    lengthPrefixed(encoder.encode(envelope.pair_key_id)),
    lengthPrefixed(run),
    lengthPrefixed(encoder.encode(envelope.sender_key_id)),
    lengthPrefixed(encoder.encode(envelope.recipient_key_id)),
    u64be(envelope.sequence),
  );
}

function validateHeaderValues(header: Omit<Bb84ControlExpectation, 'runId' | 'sequence'> | Bb84ControlExpectation, sequence: number): void {
  if (!ROOM_PATTERN.test(header.roomId) || !ID_PATTERN.test(header.pairKeyId)
    || !ID_PATTERN.test(header.senderKeyId) || !ID_PATTERN.test(header.recipientKeyId)
    || !Number.isInteger(sequence) || sequence < 0 || sequence > BB84_CONTROL_MAX_SEQUENCE) {
    throw new Error('BB84 control header is invalid.');
  }
}

function nonceForSequence(sequence: number): Uint8Array {
  return concatBytes(new Uint8Array(4), u64be(sequence));
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 65_535) throw new Error('BB84 control header field is too long.');
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, bytes.length, false);
  return concatBytes(prefix, bytes);
}

function u64be(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) throw new Error('BB84 control value is not base64url.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new Error('BB84 control value is not canonical base64url.');
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((field, index) => field === [...expected].sort()[index]);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
