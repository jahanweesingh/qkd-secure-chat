import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cryptoOperations from '../e2ee';
import * as traceOperations from '../securityTrace';
import { MockWebSocket } from '../test/MockWebSocket';
import type { ChatSession, RoomSnapshot } from '../types';
import { useChat } from './useChat';

const empty: RoomSnapshot = { messages: [], participants: [] };
let run = 0;

function session(): ChatSession {
  return {
    clientId: 'alice-client', displayName: 'Alice', roomCode: `TRACE-${++run}`,
    roomRoute: 'local', roomHost: null,
  };
}

async function connectRoom() {
  const localSession = session();
  const peer = await cryptoOperations.generateIdentity();
  const advertisement = {
    type: 'e2ee_public_key', client_id: 'bob-client', display_name: 'Bob',
    version: 'e2ee-v1', algorithm: 'ECDH-P256', public_key: peer.publicKey,
    public_key_id: peer.publicKeyId,
  };
  const connected = (messages: unknown[] = []) => ({
    type: 'connected', room_id: localSession.roomCode, client_id: localSession.clientId,
    participants: [{ client_id: 'bob-client', display_name: 'Bob' }],
    messages, e2ee_public_keys: [advertisement],
  });
  const hook = renderHook(({ activeSession }) => useChat(activeSession, empty), {
    initialProps: { activeSession: localSession as ChatSession | null },
  });
  const socket = MockWebSocket.instances.at(-1)!;
  act(() => { socket.open(); socket.receive(connected()); });
  await waitFor(() => expect(hook.result.current.encryption.canSend).toBe(true));
  const hello = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === 'e2ee_hello');
  const peerContext = await cryptoOperations.deriveContext(
    peer, hello.public_key, hello.public_key_id, localSession.roomCode,
  );
  const incoming = async (messageId = 'incoming-one', text = 'Private content stays out of diagnostics') => {
    const encrypted = await cryptoOperations.encryptText(peerContext, text, {
      roomId: localSession.roomCode, senderId: 'bob-client', senderName: 'Bob', clientMessageId: messageId,
    });
    return {
      id: `server-${messageId}`, client_message_id: messageId, sender_id: 'bob-client', sender_name: 'Bob',
      sent_at: new Date().toISOString(), kind: 'encrypted_message', version: encrypted.version,
      algorithm: 'AES-256-GCM', key_id: encrypted.keyId, sender_key_id: encrypted.senderKeyId,
      iv: encrypted.iv, ciphertext: encrypted.ciphertext,
    };
  };
  return { ...hook, socket, localSession, peerContext, incoming, connected };
}

beforeEach(() => {
  window.localStorage.clear();
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('observations at real chat boundaries', () => {
  it('records setup, actual encryption and relay acknowledgement without inventing peer decryption', async () => {
    const { result, socket } = await connectRoom();
    expect(result.current.securityTrace.map((event) => event.kind)).toEqual([
      'identity_ready', 'public_key_sent', 'peer_key_received', 'keys_derived',
    ]);
    act(() => { expect(result.current.sendMessage('Private demonstration message')).toBe(true); });
    await waitFor(() => expect(result.current.securityTrace.at(-1)?.kind).toBe('ciphertext_sent'));
    const envelope = JSON.parse(socket.sent.at(-1)!);
    const encrypted = result.current.securityTrace.find((event) => event.kind === 'message_encrypted');
    expect(encrypted).toMatchObject({
      direction: 'outgoing', source: 'live', messageId: envelope.client_message_id,
      ciphertextPreview: envelope.ciphertext.slice(0, 32),
      bytes: new TextEncoder().encode('Private demonstration message').length + 16,
    });
    expect(JSON.stringify(result.current.securityTrace)).not.toContain('Private demonstration');
    expect(result.current.securityTrace.some((event) => event.kind === 'relay_accepted')).toBe(false);
    act(() => socket.receive({ type: 'message_ack', client_message_id: 'not-sent-here' }));
    expect(result.current.securityTrace.some((event) => event.kind === 'relay_accepted')).toBe(false);
    act(() => socket.receive({ type: 'message_ack', client_message_id: envelope.client_message_id,
      message_id: '42', sent_at: '2026-11-13T08:30:00+00:00', duplicate: false }));
    await waitFor(() => expect(result.current.securityTrace.at(-1)?.kind).toBe('relay_accepted'));
    expect(result.current.securityTrace.at(-1)).toMatchObject({
      serverMessageId: '42', serverSentAt: '2026-11-13T08:30:00+00:00', duplicate: false,
    });
    expect(result.current.securityTrace.some((event) => event.kind === 'message_decrypted')).toBe(false);
  });

  it('records incoming decryption only after authentication and marks our echoed copy as outgoing', async () => {
    const { result, socket, incoming, localSession } = await connectRoom();
    const packet = await incoming();
    act(() => socket.receive({ type: 'encrypted_message', message: packet }));
    await waitFor(() => expect(result.current.securityTrace.at(-1)?.kind).toBe('message_decrypted'));
    expect(result.current.securityTrace.at(-1)).toMatchObject({ source: 'live', direction: 'incoming' });
    expect(result.current.messages.at(-1)?.text).toBe('Private content stays out of diagnostics');
    expect(JSON.stringify(result.current.securityTrace)).not.toContain('Private content');
    act(() => { result.current.sendMessage('Our own returned copy'); });
    await waitFor(() => expect(result.current.securityTrace.at(-1)?.kind).toBe('ciphertext_sent'));
    const outgoing = JSON.parse(socket.sent.at(-1)!);
    const hello = socket.sent.map((value) => JSON.parse(value)).find((value) => value.type === 'e2ee_hello');
    act(() => socket.receive({ type: 'encrypted_message', message: {
      ...outgoing, id: 'returned-copy', kind: 'encrypted_message',
      sender_id: localSession.clientId, sender_name: localSession.displayName,
      sender_key_id: hello.public_key_id, sent_at: new Date().toISOString(),
    } }));
    await waitFor(() => expect(result.current.securityTrace.at(-1)?.kind).toBe('message_decrypted'));
    expect(result.current.securityTrace.at(-1)).toMatchObject({ direction: 'outgoing' });
  });

  it('reports tampered ciphertext as a failure without recording successful decryption', async () => {
    const { result, socket, incoming } = await connectRoom();
    const packet = await incoming('tampered');
    packet.ciphertext = (packet.ciphertext[0] === 'A' ? 'B' : 'A') + packet.ciphertext.slice(1);
    act(() => socket.receive({ type: 'encrypted_message', message: packet }));
    await waitFor(() => expect(result.current.encryption.state).toBe('failed'));
    expect(result.current.securityTrace.map((event) => event.kind)).toContain('integrity_failed');
    expect(result.current.securityTrace.some((event) => event.kind === 'message_decrypted')).toBe(false);
    expect(result.current.messages.at(-1)?.security).toBe('unavailable');
  });

  it('marks recovered history separately from live receiving events', async () => {
    const { result, incoming, connected } = await connectRoom();
    const history = await incoming('historical');
    act(() => { result.current.clearSecurityTrace(); result.current.reconnect(); });
    const next = MockWebSocket.instances.at(-1)!;
    act(() => { next.open(); next.receive(connected([history])); });
    await waitFor(() => expect(result.current.securityTrace.some((event) => event.kind === 'message_decrypted')).toBe(true));
    expect(result.current.securityTrace.find((event) => event.kind === 'message_decrypted'))
      .toMatchObject({ source: 'history', direction: 'incoming', messageId: 'historical' });
    expect(result.current.securityTrace.some((event) => event.kind === 'ciphertext_received')).toBe(false);
  });

  it('clears observations independently of keys and discards a late operation from the previous room', async () => {
    const { result, rerender } = await connectRoom();
    act(() => result.current.clearSecurityTrace());
    expect(result.current.securityTrace).toEqual([]);
    expect(result.current.encryption.canSend).toBe(true);
    const originalEncrypt = cryptoOperations.encryptText;
    let finish!: () => void;
    vi.spyOn(cryptoOperations, 'encryptText').mockImplementationOnce(async (...args) => {
      const payload = await originalEncrypt(...args);
      await new Promise<void>((resolve) => { finish = resolve; });
      return payload;
    });
    act(() => { result.current.sendMessage('old room content'); });
    await waitFor(() => expect(finish).toEqual(expect.any(Function)));
    rerender({ activeSession: session() });
    await act(async () => { finish(); await Promise.resolve(); });
    expect(result.current.securityTrace).toEqual([]);
    expect(MockWebSocket.instances.at(-1)?.sent).toEqual([]);
  });

  it('does not claim encryption or sending when AES fails, and never traces the error text', async () => {
    const { result, socket } = await connectRoom();
    vi.spyOn(cryptoOperations, 'encryptText').mockRejectedValueOnce(new Error('secret failure detail'));
    act(() => { result.current.sendMessage('Never sent as plaintext'); });
    await waitFor(() => expect(result.current.securityTrace.at(-1)?.kind).toBe('message_failed'));
    expect(result.current.securityTrace.some((event) => ['message_encrypted', 'ciphertext_sent'].includes(event.kind))).toBe(false);
    expect(socket.sent.some((value) => JSON.parse(value).type === 'encrypted_message')).toBe(false);
    expect(JSON.stringify(result.current.securityTrace)).not.toContain('secret failure');
    expect(result.current.encryption.canSend).toBe(false);
  });

  it('ignores a late decryption observation after its socket was replaced', async () => {
    const { result, socket, incoming } = await connectRoom();
    const packet = await incoming('late-socket');
    let finish!: (text: string) => void;
    vi.spyOn(cryptoOperations, 'decryptText').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => socket.receive({ type: 'encrypted_message', message: packet }));
    await waitFor(() => expect(finish).toEqual(expect.any(Function)));
    act(() => window.dispatchEvent(new Event('online')));
    expect(MockWebSocket.instances.at(-1)).not.toBe(socket);
    await act(async () => { finish('Decrypted on the old socket'); await Promise.resolve(); });
    expect(result.current.securityTrace.some((event) => event.kind === 'message_decrypted')).toBe(false);
  });

  it('keeps sending encrypted messages if the presentation recorder fails', async () => {
    const { result, socket } = await connectRoom();
    vi.spyOn(traceOperations, 'makeSecurityTraceEvent').mockImplementation(() => { throw new Error('observation failure'); });
    act(() => { expect(result.current.sendMessage('Encryption remains active')).toBe(true); });
    await waitFor(() => expect(socket.sent.some((value) => JSON.parse(value).type === 'encrypted_message')).toBe(true));
    expect(result.current.encryption.canSend).toBe(true);
    expect(socket.sent.join('')).not.toContain('Encryption remains active');
  });
});
