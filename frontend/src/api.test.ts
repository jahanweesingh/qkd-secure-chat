import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebSocketUrl,
  createRoomCode,
  decodeInvitationHost,
  getHealth,
  getNetworkStatus,
  getRoomSnapshot,
  joinRoom,
  normalizeMessage,
  normalizeParticipant,
  normalizeRoomCode,
} from './api';

describe('chat API contract', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.restoreAllMocks());

  it('normalizes room codes and creates backend-safe codes', () => {
    expect(normalizeRoomCode('  room !! 42  ')).toBe('ROOM42');
    expect(normalizeRoomCode('---room-42')).toBe('ROOM-42');
    expect(createRoomCode()).toMatch(/^QKD-[A-Z2-9]{6}$/);
  });

  it('creates and validates fixed-width private-LAN invitation codes', () => {
    const roomCode = createRoomCode('192.168.1.42');
    expect(roomCode).toMatch(/^QKD-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{7}$/);
    expect(roomCode).toHaveLength(28);
    expect(roomCode.endsWith('-30AG09A')).toBe(true);
    expect(decodeInvitationHost(roomCode)).toBe('192.168.1.42');
    expect(decodeInvitationHost('QKD-0123456789ABCDEF-30AG09A')).toBe('192.168.1.42');
    expect(decodeInvitationHost('QKD-0123456789ABCDEF-0000000')).toBeNull();
    expect(createRoomCode('192.0.0.2')).toMatch(/^QKD-[A-Z2-9]{6}$/);
  });

  it('creates hosted codes with 16 cryptographically random characters and no LAN suffix', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const fallback = vi.spyOn(Math, 'random');
    const roomCode = createRoomCode('192.168.1.42', 'hosted');
    expect(roomCode).toBe('QKD-0123456789ABCDEF');
    expect(getRandomValues).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(decodeInvitationHost(roomCode)).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('refuses hosted code generation when Web Crypto randomness is unavailable', () => {
    vi.stubGlobal('crypto', {});
    const fallback = vi.spyOn(Math, 'random');
    expect(() => createRoomCode(null, 'hosted')).toThrow('Secure room-code generation is unavailable');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rejects an invitation-like code outside the strict Crockford alphabet', async () => {
    await expect(joinRoom({
      displayName: 'Asha',
      roomCode: 'QKD-IIIIIIIIIIIIIIII-30AG09A',
      mode: 'join',
    })).rejects.toThrow('invalid private network address');
  });

  it('normalizes exact nested server messages and participant shapes', () => {
    expect(normalizeMessage({
      type: 'message',
      message: {
        id: '17',
        client_message_id: 'client-message-1',
        sender_id: 'guest-2',
        sender_name: 'Mira',
        text: 'Hello from the other side',
        sent_at: '2026-09-08T09:30:00.000Z',
        kind: 'message',
      },
    })).toMatchObject({
      id: '17',
      clientMessageId: 'client-message-1',
      senderId: 'guest-2',
      senderName: 'Mira',
      text: 'Hello from the other side',
      status: 'sent',
      security: 'legacy_plaintext',
    });
    expect(normalizeParticipant({ client_id: 'guest-2', display_name: 'Mira' }))
      .toEqual({ id: 'guest-2', name: 'Mira', online: true });
  });

  it('never falls back to plaintext when an encrypted event is malformed', () => {
    expect(normalizeMessage({
      type: 'encrypted_message',
      message: {
        id: 'forged-1',
        client_message_id: 'forged-client-1',
        sender_id: 'guest-2',
        sender_name: 'Mira',
        kind: 'encrypted_message',
        text: 'This fallback must never render',
        version: 'e2ee-v1',
        algorithm: 'AES-256-GCM',
        key_id: 'pair-key',
        sender_key_id: 'sender-key',
        iv: 'not-valid-base64',
      },
    })).toBeNull();
  });

  it('keeps system notices distinct from legacy plaintext chat', () => {
    expect(normalizeMessage({
      id: 'system-1',
      sender_id: 'system',
      sender_name: 'System',
      kind: 'system',
      text: 'Mira joined the room',
    })).toMatchObject({
      kind: 'system',
      text: 'Mira joined the room',
      security: undefined,
    });
  });

  it('uses the documented health and room-history endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'ok',
        database: 'ok',
        service: 'secure-chat-starter',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        room_id: 'ROOM-42',
        messages: [],
        participants: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getHealth()).resolves.toBe(true);
    await expect(getRoomSnapshot('ROOM-42')).resolves.toEqual({
      messages: [],
      participants: [],
      e2eeRequired: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/health', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/rooms/ROOM-42/messages?limit=50',
      expect.any(Object),
    );
  });

  it('normalizes a ready LAN network response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      mode: 'lan',
      advertised_host: '10.0.0.42',
      port: 8080,
      ready: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getNetworkStatus()).resolves.toEqual({
      mode: 'lan',
      advertisedHost: '10.0.0.42',
      port: 8080,
      ready: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/network', expect.any(Object));
  });

  it('accepts the explicit hosted network contract without requiring a private address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      mode: 'hosted', advertised_host: null, port: 8080, ready: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(getNetworkStatus()).resolves.toEqual({
      mode: 'hosted', advertisedHost: null, port: 8080, ready: true,
    });
  });

  it.each([
    { advertised_host: '10.0.0.42' },
    { advertised_host: '' },
    { advertised_host: undefined },
    { advertisedHost: '10.0.0.42' },
    { ready: false },
    { ready: 'true' },
    { port: 0 },
    { port: 65_536 },
    { port: 8080.5 },
    { port: '8080' },
    { port: undefined },
    { mode: 'HOSTED' },
  ])('does not activate hosted mode for an invalid network contract: %j', async (override) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      mode: 'hosted', advertised_host: null, port: 8080, ready: true, ...override,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(getNetworkStatus()).rejects.toThrow('invalid connection mode');
  });

  it('accepts a confirmed localhost server but rejects missing or unknown network metadata', async () => {
    const response = (payload: unknown) => new Response(JSON.stringify(payload),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ mode: 'localhost', advertised_host: null, port: 8080, ready: false }))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ mode: 'unknown', advertised_host: null, port: 8080, ready: false })));
    await expect(getNetworkStatus()).resolves.toEqual({
      mode: 'localhost', advertisedHost: null, port: 8080, ready: false,
    });
    await expect(getNetworkStatus()).rejects.toThrow('invalid connection mode');
    await expect(getNetworkStatus()).rejects.toThrow('invalid connection mode');
  });

  it('keeps hosted room history and route on the same server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [], participants: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const roomCode = createRoomCode(null, 'hosted');
    await expect(joinRoom({ roomCode, displayName: 'Alice', mode: 'join' })).resolves.toMatchObject({
      roomCode, roomRoute: 'local', roomHost: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/rooms/${roomCode}/messages?limit=50`, expect.any(Object));
  });

  it('builds a same-origin WebSocket URL with exact backend parameters', () => {
    const url = new URL(buildWebSocketUrl({
      roomCode: 'ROOM-42',
      clientId: 'client-7',
      displayName: 'Asha Rao',
    }));
    expect(url.pathname).toBe('/ws/ROOM-42');
    expect(url.searchParams.get('client_id')).toBe('client-7');
    expect(url.searchParams.get('display_name')).toBe('Asha Rao');
    expect(['ws:', 'wss:']).toContain(url.protocol);
  });
});
