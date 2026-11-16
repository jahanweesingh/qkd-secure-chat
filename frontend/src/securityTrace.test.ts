import { describe, expect, it } from 'vitest';
import {
  appendSecurityTrace, ciphertextTraceDetails, makeSecurityTraceEvent, SECURITY_TRACE_LIMIT,
} from './securityTrace';
import type { SecurityTraceDetail, SecurityTraceEvent, SecurityTraceKind } from './securityTrace';

describe('local security observation boundary', () => {
  it('copies only allowed metadata and bounds actual ciphertext previews', () => {
    const unsafe = {
      source: 'live', direction: 'outgoing', messageId: 'test-message', bytes: 32,
      ciphertextPreview: 'A'.repeat(100), text: 'private message', privateKey: 'secret',
      aesKey: 'secret', iv: 'not-for-the-trace', error: 'sensitive error detail',
    };
    expect(makeSecurityTraceEvent(1, 'message_encrypted', unsafe as SecurityTraceDetail, 1234)).toEqual({
      id: 'observation-1', kind: 'message_encrypted', timestamp: 1234, source: 'live',
      direction: 'outgoing', messageId: 'test-message', bytes: 32, ciphertextPreview: 'A'.repeat(32),
    });
  });

  it('rejects unknown kinds and sanitizes unsupported values', () => {
    expect(makeSecurityTraceEvent(1, 'plaintext' as SecurityTraceKind)).toBeNull();
    expect(makeSecurityTraceEvent(-1, 'keys_derived')).toBeNull();
    expect(makeSecurityTraceEvent(1, 'keys_derived', {}, Infinity)).toBeNull();
    expect(makeSecurityTraceEvent(2, 'message_failed', {
      messageId: 'not a message identifier', bytes: 99999, ciphertextPreview: '<unsafe>',
    }, 1)).toEqual({ id: 'observation-2', kind: 'message_failed', timestamp: 1, source: 'live' });
  });

  it('keeps only the newest 60 observations', () => {
    let events: SecurityTraceEvent[] = [];
    for (let index = 0; index < 100; index += 1) {
      events = appendSecurityTrace(events, makeSecurityTraceEvent(index, 'public_key_sent', {}, index));
    }
    expect(events).toHaveLength(SECURITY_TRACE_LIMIT);
    expect(events[0].id).toBe('observation-40');
    expect(events.at(-1)?.id).toBe('observation-99');
    expect(appendSecurityTrace(events, null)).toBe(events);
  });

  it('retains only bounded public acknowledgement fields on actual ACK observations', () => {
    const detail = { serverMessageId: '42', serverSentAt: '2026-11-13T08:30:00+00:00', duplicate: false };
    expect(makeSecurityTraceEvent(1, 'relay_accepted', detail)).toMatchObject(detail);
    expect(makeSecurityTraceEvent(1, 'keys_derived', detail)).not.toHaveProperty('serverMessageId');
    const unsafe = makeSecurityTraceEvent(1, 'relay_accepted', {
      serverMessageId: 'not-a-record-id', serverSentAt: 'private diagnostic text',
      duplicate: 'yes' as unknown as boolean,
    });
    expect(unsafe).not.toHaveProperty('serverMessageId');
    expect(unsafe).not.toHaveProperty('serverSentAt');
    expect(unsafe).not.toHaveProperty('duplicate');
  });

  it('does not throw for a failed metadata accessor', () => {
    const detail = Object.defineProperty({}, 'source', { get() { throw new Error('metadata fault'); } });
    expect(makeSecurityTraceEvent(1, 'keys_derived', detail)).toBeNull();
  });

  it('derives ciphertext length without decoding or retaining the whole payload', () => {
    const ciphertext = 'A'.repeat(43);
    expect(ciphertextTraceDetails(ciphertext)).toEqual({ bytes: 32, ciphertextPreview: 'A'.repeat(32) });
    expect(ciphertextTraceDetails('A'.repeat(23))).toEqual({ bytes: 17, ciphertextPreview: 'A'.repeat(19) });
    expect(ciphertextTraceDetails('Hello private world')).toEqual({});
    expect(ciphertextTraceDetails('A'.repeat(5_484))).toEqual({});
    expect(ciphertextTraceDetails('A'.repeat(25))).toEqual({});
  });
});
