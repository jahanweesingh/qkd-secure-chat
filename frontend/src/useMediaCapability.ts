import { useCallback, useEffect, useRef } from 'react';
import type { ChatMessage, ChatSession, EncryptionInfo } from './types';

const PREFIX = 'QKD-MEDIA-CONTROL-V1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UPGRADE_REQUIRED = 'Your partner needs the updated app. Ask them to refresh, then try again.';
const CHANGED_CONTEXT = 'The device key or room changed. Review security, then send the file again.';
type Control = { type: 'hello' | 'ack'; nonce: string };
interface Options {
  messages: ChatMessage[];
  session: ChatSession;
  encryption: EncryptionInfo;
  sendMessage: (text: string) => boolean;
}
interface Pending {
  context: string;
  finish: (error?: Error) => void;
}

/** Filter all reserved controls, including malformed ones, from the product log. */
export function isMediaControl(text: string): boolean {
  return text.startsWith(PREFIX);
}

function parse(text: string): Control | null {
  if (!isMediaControl(text) || text.length > 160) return null;
  try {
    const value: unknown = JSON.parse(text.slice(PREFIX.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'nonce,type'
      || (item.type !== 'hello' && item.type !== 'ack')
      || typeof item.nonce !== 'string' || !UUID.test(item.nonce)) return null;
    return item as Control;
  } catch { return null; }
}

function remember(set: Set<string>, value: string): void {
  set.add(value);
  while (set.size > 256) set.delete(set.values().next().value!);
}

/** A per-transfer capability check, carried by authenticated chat encryption.
 * It contains no file secrets. Old clients can display this harmless probe but
 * cannot acknowledge it, so the attachment manifest never reaches them. */
export function useMediaCapability({ messages, session, encryption, sendMessage }: Options): {
  ensurePeerMedia: (signal: AbortSignal) => Promise<void>;
} {
  const context = JSON.stringify([session.roomCode, session.clientId, encryption.sessionKeyId]);
  const pending = useRef(new Map<string, Pending>());
  // Existing history is not a new capability request. The bounded tail also
  // prevents retained historical messages from cycling through the seen cache.
  const seenIds = useRef(new Set(messages.slice(-128).map(message => message.id)));
  const replied = useRef(new Set<string>());
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    const requests = pending.current;
    return () => {
      active.current = false;
      for (const item of requests.values()) item.finish(new DOMException('Attachment transfer cancelled.', 'AbortError'));
    };
  }, []);

  useEffect(() => {
    for (const item of pending.current.values()) {
      if (item.context !== context || !encryption.canSend) item.finish(new Error(CHANGED_CONTEXT));
    }
  }, [context, encryption.canSend]);

  useEffect(() => {
    if (!encryption.canSend || !encryption.sessionKeyId) return;
    for (const message of messages.slice(-128)) {
      if (seenIds.current.has(message.id)
        || message.senderId === session.clientId
        || message.security !== 'encrypted'
        || message.encryption?.keyId !== encryption.sessionKeyId) continue;
      remember(seenIds.current, message.id);
      const control = parse(message.text);
      if (!control) continue;
      if (control.type === 'ack') {
        const request = pending.current.get(control.nonce);
        if (request?.context === context) request.finish();
      } else {
        const replyId = `${encryption.sessionKeyId}:${control.nonce}`;
        if (replied.current.has(replyId)) continue;
        // Mark before sending: synchronous mock or state updates must not loop.
        remember(replied.current, replyId);
        sendMessage(PREFIX + JSON.stringify({ type: 'ack', nonce: control.nonce }));
      }
    }
  }, [messages, session.clientId, encryption.canSend, encryption.sessionKeyId, context, sendMessage]);

  const ensurePeerMedia = useCallback((signal: AbortSignal): Promise<void> => {
    if (signal.aborted || !active.current) return Promise.reject(new DOMException('Attachment transfer cancelled.', 'AbortError'));
    if (!encryption.canSend || !encryption.sessionKeyId) return Promise.reject(new Error('Wait for chat encryption before sharing a file.'));
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => finish(new DOMException('Attachment transfer cancelled.', 'AbortError'));
      const timer = setTimeout(() => finish(new Error(UPGRADE_REQUIRED)), 8000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        pending.current.delete(nonce);
        if (error) reject(error); else resolve();
      };
      pending.current.set(nonce, { context, finish });
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!sendMessage(PREFIX + JSON.stringify({ type: 'hello', nonce }))) finish(new Error('Could not contact your partner. Reconnect and try again.'));
      } catch {
        finish(new Error('Could not contact your partner. Reconnect and try again.'));
      }
    });
  }, [context, encryption.canSend, encryption.sessionKeyId, sendMessage]);

  return { ensurePeerMedia };
}
