/** Local observations only. This is neither a packet capture nor a delivery receipt. */
export const SECURITY_TRACE_LIMIT = 60;

export const SECURITY_TRACE_KINDS = [
  'identity_ready', 'public_key_sent', 'peer_key_received', 'keys_derived',
  'key_changed', 'message_encrypted', 'ciphertext_sent', 'relay_accepted',
  'ciphertext_received', 'message_decrypted', 'integrity_failed',
  'encryption_failed', 'message_failed', 'connection_closed',
] as const;

export type SecurityTraceKind = typeof SECURITY_TRACE_KINDS[number];

export interface SecurityTraceEvent {
  id: string;
  kind: SecurityTraceKind;
  /** Local observation time, not a synchronized network or crypto duration. */
  timestamp: number;
  source: 'live' | 'history';
  direction?: 'outgoing' | 'incoming';
  messageId?: string;
  /** Encrypted payload length including its authentication tag. */
  bytes?: number;
  /** A prefix of real ciphertext, never plaintext or any key material. */
  ciphertextPreview?: string;
  /** Public fields received in the backend acknowledgement, never a secret. */
  serverMessageId?: string;
  serverSentAt?: string;
  duplicate?: boolean;
}

export type SecurityTraceDetail = Pick<SecurityTraceEvent,
  'source' | 'direction' | 'messageId' | 'bytes' | 'ciphertextPreview'
  | 'serverMessageId' | 'serverSentAt' | 'duplicate'>;

/** Copy an explicit allowlist. Never spread message/envelope/error objects into the trace. */
export function makeSecurityTraceEvent(
  id: number,
  kind: SecurityTraceKind,
  detail: Partial<SecurityTraceDetail> = {},
  timestamp = Date.now(),
): SecurityTraceEvent | null {
  try {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isFinite(timestamp)
      || !SECURITY_TRACE_KINDS.includes(kind)) return null;
    const event: SecurityTraceEvent = {
      id: `observation-${id}`,
      kind,
      timestamp,
      source: detail.source === 'history' ? 'history' : 'live',
    };
    if (detail.direction === 'outgoing' || detail.direction === 'incoming') {
      event.direction = detail.direction;
    }
    if (typeof detail.messageId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(detail.messageId)) {
      event.messageId = detail.messageId;
    }
    if (typeof detail.bytes === 'number' && Number.isSafeInteger(detail.bytes)
      && detail.bytes >= 0 && detail.bytes <= 4_112) event.bytes = detail.bytes;
    if (typeof detail.ciphertextPreview === 'string'
      && /^[A-Za-z0-9_-]+$/.test(detail.ciphertextPreview)) {
      event.ciphertextPreview = detail.ciphertextPreview.slice(0, 32);
    }
    if (kind === 'relay_accepted') {
      if (typeof detail.serverMessageId === 'string' && /^\d{1,20}$/.test(detail.serverMessageId)) {
        event.serverMessageId = detail.serverMessageId;
      }
      if (typeof detail.serverSentAt === 'string' && detail.serverSentAt.length <= 40
        && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(detail.serverSentAt)
        && Number.isFinite(Date.parse(detail.serverSentAt))) event.serverSentAt = detail.serverSentAt;
      if (typeof detail.duplicate === 'boolean') event.duplicate = detail.duplicate;
    }
    return event;
  } catch {
    // Presentation must never interrupt encryption, even if given a throwing getter.
    return null;
  }
}

export function appendSecurityTrace(
  events: SecurityTraceEvent[], event: SecurityTraceEvent | null,
): SecurityTraceEvent[] {
  return event ? [...events.slice(-(SECURITY_TRACE_LIMIT - 1)), event] : events;
}

/** Accept only bounded, canonical-shaped message ciphertext before deriving metadata. */
export function ciphertextTraceDetails(ciphertext: string): Partial<SecurityTraceDetail> {
  if (typeof ciphertext !== 'string' || ciphertext.length < 23 || ciphertext.length > 5_483
    || ciphertext.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) return {};
  return {
    bytes: Math.floor(ciphertext.length * 3 / 4),
    // Even a one-character message yields only a prefix, not the full envelope body.
    ciphertextPreview: ciphertext.slice(0, Math.min(32, ciphertext.length - 4)),
  };
}
