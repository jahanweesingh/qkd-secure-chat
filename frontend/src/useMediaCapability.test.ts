import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMediaControl, useMediaCapability } from './useMediaCapability';
import type { ChatMessage, ChatSession, EncryptionInfo } from './types';

const prefix = 'QKD-MEDIA-CONTROL-V1:';
const session: ChatSession = { clientId: 'alice', displayName: 'Alice', roomCode: 'ROOM-42', roomRoute: 'local', roomHost: null };
const encryption: EncryptionInfo = {
  state: 'encrypted_unverified', canSend: true, activeKeyMode: 'ecdh', sessionKeyId: 'pair-key', peerKeyId: 'bob-key', localKeyId: 'alice-key',
  verificationCode: null, verifiedAt: null, peerName: 'Bob', keyStorage: 'device', error: null,
};
function control(type: 'hello' | 'ack', nonce: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(), senderId: 'bob', senderName: 'Bob', text: prefix + JSON.stringify({ type, nonce }),
    sentAt: new Date().toISOString(), kind: 'message', security: 'encrypted',
    encryption: { version: 'e2ee-v1', algorithm: 'AES-256-GCM', keyId: 'pair-key', senderKeyId: 'bob-key', iv: 'opaque', ciphertext: 'opaque' }, ...overrides,
  };
}
function setup(initial: ChatMessage[] = []) {
  const sendMessage = vi.fn<(text: string) => boolean>(() => true);
  const hook = renderHook(({ messages, info }: { messages: ChatMessage[]; info: EncryptionInfo }) => useMediaCapability({ messages, session, encryption: info, sendMessage }), { initialProps: { messages: initial, info: encryption } });
  return { ...hook, sendMessage };
}
function sentNonce(send: ReturnType<typeof vi.fn>): string {
  return JSON.parse(String(send.mock.calls[0][0]).slice(prefix.length)).nonce;
}
afterEach(() => vi.useRealTimers());

describe('authenticated per-transfer media capability', () => {
  it('does not send anything on initial mount, including retained history', () => {
    const { sendMessage } = setup([control('hello', crypto.randomUUID())]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends a nonsecret fresh challenge and accepts only its authenticated acknowledgment', async () => {
    const { result, rerender, sendMessage } = setup();
    let promise!: Promise<void>;
    act(() => { promise = result.current.ensurePeerMedia(new AbortController().signal); });
    const nonce = sentNonce(sendMessage);
    expect(sendMessage.mock.calls[0][0]).toBe(prefix + JSON.stringify({ type: 'hello', nonce }));
    act(() => rerender({ messages: [control('ack', nonce)], info: encryption }));
    await expect(promise).resolves.toBeUndefined();
  });

  it('replies to a live peer hello once even when the same nonce arrives in a second envelope', () => {
    const { rerender, sendMessage } = setup();
    const nonce = crypto.randomUUID();
    const hello = control('hello', nonce);
    rerender({ messages: [hello], info: encryption });
    rerender({ messages: [hello, control('hello', nonce)], info: encryption });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(prefix + JSON.stringify({ type: 'ack', nonce }));
  });

  it('ignores plaintext, own messages, old key contexts, unknown nonces and malformed controls', async () => {
    const { result, rerender, sendMessage } = setup();
    const abort = new AbortController();
    const promise = result.current.ensurePeerMedia(abort.signal);
    const caught = promise.catch(error => error);
    const nonce = sentNonce(sendMessage);
    let resolved = false;
    void promise.then(() => { resolved = true; }, () => undefined);
    const oldKey = control('ack', nonce); oldKey.encryption!.keyId = 'old-pair';
    rerender({ messages: [
      control('ack', nonce, { security: 'legacy_plaintext', encryption: undefined }),
      control('ack', nonce, { senderId: 'alice' }), oldKey, control('ack', crypto.randomUUID()),
      control('hello', nonce, { text: prefix + '{"type":"hello","nonce":"not-a-uuid"}' }),
      control('hello', nonce, { text: prefix + JSON.stringify({ type: 'hello', nonce, extra: true }) }),
    ], info: encryption });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    abort.abort();
    expect((await caught).name).toBe('AbortError');
  });

  it('processes an incoming message only after decryption authenticates it', async () => {
    const { result, rerender, sendMessage } = setup();
    const promise = result.current.ensurePeerMedia(new AbortController().signal);
    const ack = control('ack', sentNonce(sendMessage), { security: 'decrypting' });
    rerender({ messages: [ack], info: encryption });
    rerender({ messages: [{ ...ack, security: 'encrypted' }], info: encryption });
    await expect(promise).resolves.toBeUndefined();
  });

  it('times out old clients after 8 seconds and does not reuse a previous acknowledgment', async () => {
    vi.useFakeTimers();
    const { result, rerender, sendMessage } = setup();
    const first = result.current.ensurePeerMedia(new AbortController().signal);
    const oldNonce = sentNonce(sendMessage);
    rerender({ messages: [control('ack', oldNonce)], info: encryption });
    await first;
    const second = result.current.ensurePeerMedia(new AbortController().signal);
    const rejection = expect(second).rejects.toThrow('Your partner needs the updated app');
    expect(JSON.parse(sendMessage.mock.calls[1][0].slice(prefix.length)).nonce).not.toBe(oldNonce);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await rejection;
  });

  it('rejects pending checks when the key changes or sending is paused', async () => {
    const { result, rerender } = setup();
    const promise = result.current.ensurePeerMedia(new AbortController().signal);
    const rejection = expect(promise).rejects.toThrow('device key or room changed');
    rerender({ messages: [], info: { ...encryption, sessionKeyId: 'replacement', canSend: false, state: 'key_changed' } });
    await rejection;
  });

  it('cleans up aborts and unmounts without leaking timers or resolving later', async () => {
    vi.useFakeTimers();
    const { result, unmount } = setup();
    const controller = new AbortController();
    const cancelled = result.current.ensurePeerMedia(controller.signal);
    const cancellation = expect(cancelled).rejects.toHaveProperty('name', 'AbortError');
    controller.abort();
    await cancellation;
    const pending = result.current.ensurePeerMedia(new AbortController().signal);
    const rejection = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    unmount();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not claim capability when sending fails or encryption is unavailable', async () => {
    const { result, sendMessage, rerender } = setup();
    sendMessage.mockReturnValue(false);
    await expect(result.current.ensurePeerMedia(new AbortController().signal)).rejects.toThrow('Could not contact');
    rerender({ messages: [], info: { ...encryption, canSend: false } });
    await expect(result.current.ensurePeerMedia(new AbortController().signal)).rejects.toThrow('Wait for chat encryption');
  });

  it('recognizes even malformed reserved controls for safe filtering', () => {
    expect(isMediaControl(prefix + 'malformed')).toBe(true);
    expect(isMediaControl('Hello there')).toBe(false);
  });
});
