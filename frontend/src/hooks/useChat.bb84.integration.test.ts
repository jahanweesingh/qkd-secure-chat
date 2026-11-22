import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket } from '../test/MockWebSocket';
import type { ChatSession, RoomSnapshot } from '../types';
import { downloadAttachment, parseAttachment, prepareAttachment } from '../attachments';
import { useChat } from './useChat';

const empty: RoomSnapshot = { messages: [], participants: [] };
const roomId = 'BB84-TWO-HOOK-ROOM';

function makeSession(clientId: string, displayName: string): ChatSession {
  return { clientId, displayName, roomCode: roomId, roomRoute: 'local', roomHost: null };
}

function blobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

describe('two chat endpoints with BB84 key establishment', () => {
  beforeEach(() => {
    window.localStorage.clear();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('confirms a matching hybrid epoch and sends an AES-GCM chat message through the existing path', async () => {
    const storedAttachments = new Map<string, Uint8Array>();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const attachmentId = url.split('/').at(-1)!;
      if (init?.method === 'POST') {
        storedAttachments.set(attachmentId, new Uint8Array(init.body as ArrayBuffer));
        return new Response(null, { status: 201 });
      }
      const bytes = storedAttachments.get(attachmentId);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    }));
    const aliceSession = makeSession('alice-chat-client', 'Alice');
    const bobSession = makeSession('bob-chat-client', 'Bob');
    const aliceHook = renderHook(() => useChat(aliceSession, empty));
    const aliceSocket = MockWebSocket.instances.at(-1)!;
    const bobHook = renderHook(() => useChat(bobSession, empty));
    const bobSocket = MockWebSocket.instances.at(-1)!;

    const socketSessions = new Map([
      [aliceSocket, { own: aliceSession, peerSocket: bobSocket }],
      [bobSocket, { own: bobSession, peerSocket: aliceSocket }],
    ]);
    MockWebSocket.onSend = (source, raw) => {
      const packet = JSON.parse(raw) as Record<string, unknown>;
      if (packet.type === 'bb84_control') {
        queueMicrotask(() => socketSessions.get(source)?.peerSocket.receive(packet));
      }
      if (packet.type === 'encrypted_message') {
        const link = socketSessions.get(source)!;
        const localHello = source.sent.map((value) => JSON.parse(value) as Record<string, unknown>)
          .find((value) => value.type === 'e2ee_hello')!;
        const message = {
          id: `server-${String(packet.client_message_id)}`,
          client_message_id: packet.client_message_id,
          sender_id: link.own.clientId,
          sender_name: link.own.displayName,
          sent_at: new Date().toISOString(),
          kind: 'encrypted_message',
          ...packet,
          sender_key_id: localHello.public_key_id,
        };
        queueMicrotask(() => link.peerSocket.receive({ type: 'encrypted_message', message }));
      }
    };

    act(() => {
      aliceSocket.open();
      aliceSocket.receive({ type: 'connected', room_id: roomId, participants: [], messages: [] });
      bobSocket.open();
      bobSocket.receive({ type: 'connected', room_id: roomId, participants: [], messages: [] });
    });
    await waitFor(() => {
      expect(aliceSocket.sent.some((value) => JSON.parse(value).type === 'e2ee_hello')).toBe(true);
      expect(bobSocket.sent.some((value) => JSON.parse(value).type === 'e2ee_hello')).toBe(true);
    });
    const aliceHello = aliceSocket.sent.map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((value) => value.type === 'e2ee_hello')!;
    const bobHello = bobSocket.sent.map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((value) => value.type === 'e2ee_hello')!;
    act(() => {
      aliceSocket.receive({
        type: 'e2ee_public_key', client_id: bobSession.clientId, display_name: 'Bob',
        version: 'e2ee-v1', algorithm: 'ECDH-P256',
        public_key: bobHello.public_key, public_key_id: bobHello.public_key_id,
      });
      bobSocket.receive({
        type: 'e2ee_public_key', client_id: aliceSession.clientId, display_name: 'Alice',
        version: 'e2ee-v1', algorithm: 'ECDH-P256',
        public_key: aliceHello.public_key, public_key_id: aliceHello.public_key_id,
      });
    });
    await waitFor(() => {
      expect(aliceHook.result.current.encryption.canSend).toBe(true);
      expect(bobHook.result.current.encryption.canSend).toBe(true);
    });

    act(() => {
      expect(aliceHook.result.current.startEndpointBb84({
        qubitCount: 512, noiseProbability: 0, interceptProbability: 0,
        sampleRatio: 0.25, qberThreshold: 0.11, seed: null,
      })).toBe(true);
    });
    await waitFor(() => {
      expect(aliceHook.result.current.endpointBb84.status).toBe('complete');
      expect(bobHook.result.current.endpointBb84.status).toBe('complete');
      expect(aliceHook.result.current.encryption.activeKeyMode).toBe('bb84_hybrid');
      expect(bobHook.result.current.encryption.activeKeyMode).toBe('bb84_hybrid');
    }, { timeout: 15_000 });
    expect(aliceHook.result.current.endpointBb84.qberPpm).toBe(0);
    expect(bobHook.result.current.endpointBb84.qberPpm).toBe(0);

    act(() => { expect(aliceHook.result.current.sendMessage('Hybrid encrypted hello')).toBe(true); });
    await waitFor(() => expect(
      bobHook.result.current.messages.some((message) => message.text === 'Hybrid encrypted hello'),
    ).toBe(true));
    const chatEnvelope = aliceSocket.sent.map((value) => JSON.parse(value) as Record<string, unknown>)
      .filter((value) => value.type === 'encrypted_message').at(-1)!;
    expect(chatEnvelope.ciphertext).not.toContain('Hybrid encrypted hello');

    act(() => aliceHook.result.current.useEcdhFallback());
    expect(aliceHook.result.current.encryption.activeKeyMode).toBe('ecdh');
    act(() => { expect(aliceHook.result.current.sendMessage('ECDH fallback hello')).toBe(true); });
    await waitFor(() => expect(
      bobHook.result.current.messages.some((message) => message.text === 'ECDH fallback hello'),
    ).toBe(true));

    const mediaSamples = [
      { name: 'demo.png', type: 'image/png', bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
      { name: 'demo.webm', type: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4] },
    ];
    for (const sample of mediaSamples) {
      const file = {
        name: sample.name, type: sample.type, size: sample.bytes.length,
        arrayBuffer: async () => Uint8Array.from(sample.bytes).buffer,
      } as File;
      const attachmentManifest = await prepareAttachment(file, roomId);
      act(() => { expect(aliceHook.result.current.sendMessage(attachmentManifest)).toBe(true); });
      await waitFor(() => expect(
        bobHook.result.current.messages.some((message) => message.text === attachmentManifest),
      ).toBe(true));
      const manifest = parseAttachment(attachmentManifest)!;
      const received = await downloadAttachment(manifest, roomId);
      expect(await blobBytes(received)).toEqual(sample.bytes);
      expect(storedAttachments.get(manifest.id)).not.toEqual(Uint8Array.from(sample.bytes));
    }

    act(() => aliceHook.unmount());
    act(() => bobHook.unmount());
  });
});
