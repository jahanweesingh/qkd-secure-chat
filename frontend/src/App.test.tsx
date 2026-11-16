import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as attachments from './attachments';
import * as mediaCapability from './useMediaCapability';
import { createRoomCode } from './api';
import {
  decryptText,
  deriveContext,
  encryptText,
  generateIdentity,
} from './e2ee';
import type { E2eeIdentity } from './e2ee';
import { MockWebSocket } from './test/MockWebSocket';

let peerIdentity: E2eeIdentity;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalDialogClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalDialogClose;
});

const historyPayload = {
  room_id: 'ROOM-42',
  messages: [{
    id: '1',
    client_message_id: 'old-1',
    sender_id: 'guest-2',
    sender_name: 'Mira',
    text: 'I am already here.',
    sent_at: '2026-09-08T09:30:00.000Z',
    kind: 'message',
  }],
  participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const localNetworkPayload = {
  mode: 'localhost',
  advertised_host: null,
  port: 8080,
  ready: false,
};

const hostedNetworkPayload = {
  mode: 'hosted',
  advertised_host: null,
  port: 8080,
  ready: true,
};

function completedPostProcessing(inputBits: number) {
  return {
    version: 'phase3-post-processing-v1',
    status: 'completed',
    reason: 'completed',
    input_bits: inputBits,
    reconciliation: {
      algorithm: 'cascade-inspired-parity-v1',
      passes: 6,
      corrected_errors: 2,
      remaining_errors: 0,
      leaked_bits: Math.min(12, inputBits),
      verified: true,
    },
    privacy_amplification: {
      algorithm: 'toeplitz-universal-hash-v1',
      entropy_model: 'illustrative-asymptotic-bb84-binary-entropy-v1',
      security_margin_bits: 32,
      estimated_secret_bits: Math.max(128, inputBits - 56),
      output_bits: 128,
    },
    confirmation: {
      algorithm: 'hmac-sha256-truncated-v1',
      tag_bits: 128,
      passed: true,
    },
    derivation: {
      algorithm: 'hkdf-sha256-v1',
      output_bits: 256,
      context_bound: true,
      material_retained: false,
    },
    key_material_exposed: false,
    key_used_for_chat: false,
    reproducible_teaching_run: false,
  };
}

function skippedPostProcessing(inputBits: number) {
  return {
    version: 'phase3-post-processing-v1',
    status: 'skipped',
    reason: 'bb84_not_accepted',
    input_bits: inputBits,
    reconciliation: {
      algorithm: 'cascade-inspired-parity-v1',
      passes: 0,
      corrected_errors: 0,
      remaining_errors: 0,
      leaked_bits: 0,
      verified: false,
    },
    privacy_amplification: {
      algorithm: 'toeplitz-universal-hash-v1',
      entropy_model: 'illustrative-asymptotic-bb84-binary-entropy-v1',
      security_margin_bits: 32,
      estimated_secret_bits: 0,
      output_bits: 0,
    },
    confirmation: {
      algorithm: 'hmac-sha256-truncated-v1',
      tag_bits: 128,
      passed: false,
    },
    derivation: {
      algorithm: 'hkdf-sha256-v1',
      output_bits: 0,
      context_bound: false,
      material_retained: false,
    },
    key_material_exposed: false,
    key_used_for_chat: false,
    reproducible_teaching_run: false,
  };
}

function insufficientEntropyPostProcessing(inputBits: number, reproducible = false) {
  return {
    version: 'phase3-post-processing-v1',
    status: 'failed',
    reason: 'insufficient_entropy',
    input_bits: inputBits,
    reconciliation: {
      algorithm: 'cascade-inspired-parity-v1',
      passes: 6,
      corrected_errors: Math.min(1, inputBits),
      remaining_errors: 0,
      leaked_bits: Math.min(8, inputBits),
      verified: true,
    },
    privacy_amplification: {
      algorithm: 'toeplitz-universal-hash-v1',
      entropy_model: 'illustrative-asymptotic-bb84-binary-entropy-v1',
      security_margin_bits: 32,
      estimated_secret_bits: Math.max(0, inputBits - 16),
      output_bits: 0,
    },
    confirmation: {
      algorithm: 'hmac-sha256-truncated-v1',
      tag_bits: 128,
      passed: false,
    },
    derivation: {
      algorithm: 'hkdf-sha256-v1',
      output_bits: 0,
      context_bound: false,
      material_retained: false,
    },
    key_material_exposed: false,
    key_used_for_chat: false,
    reproducible_teaching_run: reproducible,
  };
}

function reconciliationFailurePostProcessing(inputBits: number) {
  const insufficient = insufficientEntropyPostProcessing(inputBits);
  return {
    ...insufficient,
    reason: 'reconciliation_failed',
    reconciliation: {
      ...insufficient.reconciliation,
      remaining_errors: 1,
      verified: false,
    },
    privacy_amplification: {
      ...insufficient.privacy_amplification,
      estimated_secret_bits: 0,
    },
  };
}

function confirmationFailurePostProcessing(inputBits: number) {
  const completed = completedPostProcessing(inputBits);
  return {
    ...completed,
    status: 'failed',
    reason: 'confirmation_failed',
    confirmation: {
      ...completed.confirmation,
      passed: false,
    },
    derivation: {
      ...completed.derivation,
      output_bits: 0,
      context_bound: false,
    },
  };
}

function derivationFailurePostProcessing(inputBits: number) {
  const completed = completedPostProcessing(inputBits);
  return {
    ...completed,
    status: 'failed',
    reason: 'derivation_failed',
    derivation: {
      ...completed.derivation,
      output_bits: 0,
      context_bound: false,
    },
  };
}

const bb84BasePayload = {
  type: 'bb84_result',
  session_id: 'sim_aabbccddeeff001122334455',
  started_by: 'guest-2',
  created_at: '2026-09-13T12:00:00Z',
  simulation_only: true,
  chat_encryption_active: false,
  config: {
    qubit_count: 128,
    noise_probability: 0.02,
    intercept_probability: 0.25,
    sample_ratio: 0.25,
    qber_threshold: 0.11,
    seed: null,
  },
  metrics: {
    transmitted: 128,
    intercepted: 32,
    sifted: 64,
    sample: 16,
    mismatches: 1,
    qber: 1 / 16,
    retained: 48,
  },
  decision: { status: 'accepted', reason: 'qber_within_threshold' },
  post_processing: insufficientEntropyPostProcessing(48),
  trace: [{
    index: 0,
    alice_basis: 'Z',
    bob_basis: 'Z',
    basis_match: true,
    intercepted: true,
    sampled: true,
    sample_comparison: 'match',
  }],
};

function defaultFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  return Promise.resolve(jsonResponse(url === '/api/network' ? localNetworkPayload : historyPayload));
}

async function enterKnownRoom() {
  const user = userEvent.setup();
  const view = render(<App />);
  await user.click(screen.getByRole('button', { name: 'Join room' }));
  await user.type(screen.getByLabelText('Your name'), 'Asha');
  await user.type(screen.getByLabelText('Room code'), 'room-42');
  await user.click(screen.getByRole('button', { name: 'Join conversation' }));
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  return { user, socket: MockWebSocket.instances[0], ...view };
}

async function waitForEncryptedComposer() {
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });
  expect(screen.getByRole('button', { name: /Encrypted · unverified.*Open encryption details/i }))
    .toBeVisible();
}

describe('QKD Chat Lab experience', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    MockWebSocket.reset();
    peerIdentity = await generateIdentity();
    MockWebSocket.onSend = (socket, data) => {
      const packet = JSON.parse(data) as Record<string, unknown>;
      if (packet.type !== 'e2ee_hello') return;
      queueMicrotask(() => socket.receive({
        type: 'e2ee_public_key',
        client_id: 'guest-2',
        display_name: 'Mira',
        version: 'e2ee-v1',
        algorithm: 'ECDH-P256',
        public_key_id: peerIdentity.publicKeyId,
        public_key: peerIdentity.publicKey,
      }));
    };
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(defaultFetch));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('states the real encryption boundary before entry', async () => {
    render(<App />);
    await screen.findByText('Local rooms only');
    expect(screen.getByText('Encrypted in your browser')).toBeVisible();
    expect(screen.getByText('BB84 is a software simulation. Chat uses ECDH + AES-256-GCM.')).toBeVisible();
    expect(screen.getByText('Encryption starts inside the room')).toBeVisible();
    expect(screen.getByText(/Sending stays paused until both browsers exchange public keys/i)).toBeVisible();
  });

  it('keeps workspace tools together and supports the room-notes drawer by keyboard', async () => {
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    const { user } = await enterKnownRoom();
    const navigation = screen.getByRole('navigation', { name: 'Workspace' });
    const masthead = navigation.closest('header');
    const conversation = screen.getByRole('main', { name: 'The conversation' });
    const skipLink = screen.getByRole('link', { name: 'Skip to message composer' });
    expect(within(navigation).getByRole('link', { name: 'Conversation' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('button', { name: 'Encryption demo' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Open BB84 Security Lab' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'The conversation' })).toBeVisible();

    const trigger = screen.getByRole('button', { name: 'Open room details' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(masthead).toHaveAttribute('inert');
    expect(conversation).toHaveAttribute('inert');
    expect(skipLink).toHaveAttribute('inert');
    const notes = screen.getByRole('dialog', { name: 'Room details' });
    const close = within(notes).getByRole('button', { name: 'Close room details' });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(notes).getByRole('button', { name: 'Leave room' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Room details' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(masthead).not.toHaveAttribute('inert');
    expect(conversation).not.toHaveAttribute('inert');
    expect(skipLink).not.toHaveAttribute('inert');
    expect(trigger).toHaveFocus();
  });

  it('closes the mobile notes modal on desktop resize and restores the conversation', async () => {
    let compact = true;
    let notifyResize: ((event: MediaQueryListEvent) => void) | undefined;
    const media = {
      get matches() { return compact; },
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { notifyResize = listener; }),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    const { user } = await enterKnownRoom();
    const conversation = screen.getByRole('main', { name: 'The conversation' });
    const heading = screen.getByRole('heading', { name: 'The conversation', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Open room details' }));
    expect(screen.getByRole('dialog', { name: 'Room details' })).toHaveAttribute('aria-modal', 'true');
    expect(conversation).toHaveAttribute('inert');

    act(() => { compact = false; notifyResize?.({ matches: false } as MediaQueryListEvent); });
    expect(screen.queryByRole('dialog', { name: 'Room details' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Room details' })).not.toHaveAttribute('aria-modal');
    expect(conversation).not.toHaveAttribute('inert');
    expect(heading).toHaveFocus();

    act(() => { compact = true; notifyResize?.({ matches: true } as MediaQueryListEvent); });
    expect(screen.queryByRole('dialog', { name: 'Room details' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open room details' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps attachment selection disabled until encryption is ready and rejects oversized files', async () => {
    const { socket } = await enterKnownRoom();
    expect(screen.getByRole('button', { name: 'Attach image or video' })).toBeDisabled();
    act(() => {
      socket.open();
      socket.receive({ type: 'connected', client_id: new URL(socket.url).searchParams.get('client_id'), room_id: 'ROOM-42', participants: [{ client_id: 'guest-2', display_name: 'Mira' }], messages: historyPayload.messages });
    });
    await waitForEncryptedComposer();
    const file = new File(['too big'], 'clip.webm', { type: 'video/webm' });
    Object.defineProperty(file, 'size', { value: attachments.MAX_ATTACHMENT_BYTES + 1 });
    fireEvent.change(screen.getByLabelText('Choose image or video'), { target: { files: [file] } });
    expect(screen.getByRole('alert')).toHaveTextContent('up to 10 MB');
    expect(screen.queryByRole('region', { name: 'Attachment preview' })).not.toBeInTheDocument();
  });

  it('lets a selected file be removed without uploading or losing a text draft', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({ type: 'connected', client_id: new URL(socket.url).searchParams.get('client_id'), room_id: 'ROOM-42', participants: [{ client_id: 'guest-2', display_name: 'Mira' }], messages: historyPayload.messages });
    });
    await waitForEncryptedComposer();
    const upload = vi.spyOn(attachments, 'prepareAttachment');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this draft');
    fireEvent.change(screen.getByLabelText('Choose image or video'), { target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] } });
    expect(screen.getByRole('region', { name: 'Attachment preview' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
    expect(revoke).toHaveBeenCalledWith('blob:preview');
    expect(screen.getByRole('button', { name: 'Attach image or video' })).toHaveFocus();
  });

  it('does not share a file manifest when the partner key changes during upload', async () => {
    vi.spyOn(mediaCapability, 'useMediaCapability').mockReturnValue({ ensurePeerMedia: vi.fn().mockResolvedValue(undefined) });
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({ type: 'connected', client_id: new URL(socket.url).searchParams.get('client_id'), room_id: 'ROOM-42', participants: [{ client_id: 'guest-2', display_name: 'Mira' }], messages: historyPayload.messages });
    });
    await waitForEncryptedComposer();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    let finish!: (value: string) => void;
    vi.spyOn(attachments, 'prepareAttachment').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText('Choose image or video'), { target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] } });
    await user.click(screen.getByRole('button', { name: 'Send file' }));
    const changedPeer = await generateIdentity();
    act(() => socket.receive({ type: 'e2ee_public_key', client_id: 'guest-2', display_name: 'Mira', version: 'e2ee-v1', algorithm: 'ECDH-P256', public_key_id: changedPeer.publicKeyId, public_key: changedPeer.publicKey }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled());
    await act(async () => finish('manifest-that-must-not-be-sent'));
    expect(screen.getByRole('alert')).toHaveTextContent('connection or device key changed');
    expect(socket.sent.some(packet => JSON.parse(packet).type === 'encrypted_message')).toBe(false);
    expect(screen.queryByText('manifest-that-must-not-be-sent')).not.toBeInTheDocument();
  });

  it('shows friendly, accessible onboarding validation', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Local rooms only');
    await user.click(screen.getByRole('button', { name: 'Create and enter' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least 2 characters');
    expect(screen.getByLabelText('Your name')).toHaveFocus();
    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Your name')).toHaveAccessibleDescription('Enter a name with at least 2 characters.');
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('points to an invalid room code and clears field errors when changing mode', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Local rooms only');
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    await user.type(screen.getByLabelText('Your name'), 'Alice');
    await user.type(screen.getByLabelText('Room code'), 'A');
    await user.click(screen.getByRole('button', { name: 'Join conversation' }));
    expect(screen.getByLabelText('Room code')).toHaveFocus();
    expect(screen.getByLabelText('Room code')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Room code')).toHaveAccessibleDescription(/Use 4–64/);
    expect(screen.getByLabelText('Your name')).toHaveValue('Alice');
    await user.click(screen.getByRole('button', { name: 'Create room' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your new room code')).not.toHaveAttribute('aria-invalid');
  });

  it('keeps one lab entry and returns keyboard focus to it', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => socket.open());
    expect(screen.queryByRole('button', { name: 'Explore BB84 Security Lab' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open BB84 Security Lab' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));
    expect(screen.getByRole('dialog', { name: 'BB84 Security Lab' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'BB84 Security Lab' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open BB84 Security Lab' })).toHaveFocus();
  });

  it('creates a routable LAN invitation when this Mac is ready', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(jsonResponse(url === '/api/network' ? {
        mode: 'lan',
        advertised_host: '192.168.1.42',
        port: 8080,
        ready: true,
      } : { ...historyPayload, messages: [], participants: [] }));
    }));
    render(<App />);

    expect(await screen.findByText('LAN invitations ready')).toBeVisible();
    const roomCode = (screen.getByLabelText('Your new room code') as HTMLInputElement).value;
    expect(roomCode).toMatch(/^QKD-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{7}$/);
    await user.type(screen.getByLabelText('Your name'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Create and enter' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(screen.getAllByText('This Mac hosts the room').length).toBeGreaterThan(0);
  });

  it('creates a hosted room with a strong code and explains the shared website', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(jsonResponse(
      String(input) === '/api/network' ? hostedNetworkPayload : { ...historyPayload, messages: [], participants: [] },
    ))));
    render(<App />);
    expect(await screen.findByText('Online room server')).toBeVisible();
    expect(screen.getByText('Open this same website on both devices, then share the room code.')).toBeVisible();
    expect(screen.queryByText('Local rooms only')).not.toBeInTheDocument();
    const field = screen.getByLabelText('Your new room code') as HTMLInputElement;
    expect(field.value).toMatch(/^QKD-[0-9A-HJKMNPQRSTVWXYZ]{16}$/);
    const firstCode = field.value;
    await user.click(screen.getByRole('button', { name: 'Generate another room code' }));
    expect(field.value).toMatch(/^QKD-[0-9A-HJKMNPQRSTVWXYZ]{16}$/);
    expect(field.value).not.toBe(firstCode);
    const roomCode = field.value;
    await user.type(screen.getByLabelText('Your name'), 'Alice');
    await user.click(screen.getByRole('button', { name: 'Create and enter' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(new URL(MockWebSocket.instances[0].url).host).toBe(window.location.host);
    expect(new URL(MockWebSocket.instances[0].url).pathname).toBe(`/ws/${roomCode}`);
    expect(fetch).toHaveBeenCalledWith(`/api/rooms/${roomCode}/messages?limit=50`, expect.any(Object));
    expect(screen.getByText('Online room server')).toBeVisible();
    expect(screen.getByText('Open this same website on both devices, then share the room code.')).toBeVisible();
    expect(screen.queryByText('Local server room')).not.toBeInTheDocument();
    const socket = MockWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive({ type: 'connected', client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: roomCode, participants: [{ client_id: 'guest-2', display_name: 'Mira' }], messages: [] });
    });
    await waitForEncryptedComposer();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hosted hello{enter}');
    await waitFor(() => expect(socket.sent.some(packet => JSON.parse(packet).type === 'encrypted_message')).toBe(true));
    expect(socket.sent.some(packet => packet.includes('Hosted hello'))).toBe(false);
  });

  it('keeps hosted joining and create-mode regeneration on the shared website', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(jsonResponse(
      String(input) === '/api/network' ? hostedNetworkPayload : historyPayload,
    ))));
    render(<App />);
    await screen.findByText('Online room server');
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    expect(screen.getByText('Online room server')).toBeVisible();
    expect(screen.queryByText('Joining from another Mac?')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create room' }));
    expect((screen.getByLabelText('Your new room code') as HTMLInputElement).value).toMatch(/^QKD-[0-9A-HJKMNPQRSTVWXYZ]{16}$/);
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    await user.type(screen.getByLabelText('Your name'), 'Bob');
    await user.type(screen.getByLabelText('Room code'), 'QKD-0123456789ABCDEF');
    await user.click(screen.getByRole('button', { name: 'Join conversation' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith('/api/rooms/QKD-0123456789ABCDEF/messages?limit=50', expect.any(Object));
    expect(screen.getByText('Both devices connect to this website.')).toBeVisible();
    expect(screen.queryByText('Connecting through this Mac to room host')).not.toBeInTheDocument();
  });

  it('rejects a private LAN invitation on a hosted server before opening a connection', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(hostedNetworkPayload))));
    render(<App />);
    await screen.findByText('Online room server');
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    await user.type(screen.getByLabelText('Your name'), 'Alice');
    await user.type(screen.getByLabelText('Room code'), createRoomCode('10.0.0.42'));
    await user.click(screen.getByRole('button', { name: 'Join conversation' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This code belongs to a private LAN room');
    expect(screen.getByLabelText('Room code')).toHaveFocus();
    expect(screen.getByLabelText('Room code')).toHaveAttribute('aria-invalid', 'true');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('does not offer a weak hosted code when secure randomness is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(hostedNetworkPayload))));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Secure room-code generation is unavailable');
    expect(screen.getByLabelText('Your new room code')).toHaveValue('');
    expect(screen.getByLabelText('Your new room code')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Online room server')).toBeVisible();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('uses neutral checking copy and waits for the mode before joining', async () => {
    const user = userEvent.setup();
    let resolveNetwork!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveNetwork = resolve; })));
    render(<App />);
    expect(screen.getByText('Checking connection')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Checking connection…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    expect(screen.getByRole('button', { name: 'Checking connection…' })).toBeDisabled();
    expect(screen.queryByText('Joining from another Mac?')).not.toBeInTheDocument();
    await act(async () => resolveNetwork(jsonResponse(hostedNetworkPayload)));
    expect(await screen.findByText('Online room server')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Join conversation' })).toBeEnabled();
  });

  it.each(['unreachable', 'invalid'])('blocks room creation and joining after an %s network check, then safely retries', async failure => {
    const user = userEvent.setup();
    let networkRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== '/api/network') return Promise.resolve(jsonResponse(historyPayload));
      networkRequests += 1;
      if (networkRequests > 1) return Promise.resolve(jsonResponse(hostedNetworkPayload));
      return failure === 'unreachable'
        ? Promise.reject(new Error('Server unavailable'))
        : Promise.resolve(jsonResponse({ ...hostedNetworkPayload, port: '8080' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByText('Network status unavailable');
    expect(screen.getByLabelText('Your new room code')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Generate another room code' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create and enter' })).toBeDisabled();
    await user.type(screen.getByLabelText('Your name'), 'Alice');
    fireEvent.submit(screen.getByRole('button', { name: 'Create and enter' }).closest('form')!);
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    await user.type(screen.getByLabelText('Room code'), 'QKD-0123456789ABCDEF');
    expect(screen.getByRole('button', { name: 'Join conversation' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Join conversation' }).closest('form')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Create room' }));
    expect(screen.getByLabelText('Your new room code')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Retry connection check' }));
    await screen.findByText('Online room server');
    expect(screen.queryByRole('button', { name: 'Retry connection check' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveValue('Alice');
    const roomCode = (screen.getByLabelText('Your new room code') as HTMLInputElement).value;
    expect(roomCode).toMatch(/^QKD-[0-9A-HJKMNPQRSTVWXYZ]{16}$/);
    await user.click(screen.getByRole('button', { name: 'Create and enter' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/rooms/${roomCode}/messages?limit=50`, expect.any(Object));
    expect(networkRequests).toBe(2);
  });

  it('keeps a LAN guest on localhost and explains an unreachable room host', async () => {
    const user = userEvent.setup();
    const invitation = createRoomCode('10.0.0.42');
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    await user.type(screen.getByLabelText('Your name'), 'Asha');
    await user.type(screen.getByLabelText('Room code'), invitation);
    await user.click(screen.getByRole('button', { name: 'Join conversation' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const socket = MockWebSocket.instances[0];
    expect(new URL(socket.url).host).toBe(window.location.host);
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining(`/api/rooms/${invitation}/messages`),
      expect.any(Object),
    );
    expect(screen.getAllByText('Connecting through this Mac to room host').length)
      .toBeGreaterThan(0);

    act(() => {
      socket.open();
    });
    expect(screen.getAllByText('Connecting through this Mac to room host').length)
      .toBeGreaterThan(0);

    act(() => {
      socket.receive({
        type: 'error',
        code: 'peer_unreachable',
        message: 'The room host could not be reached on the local network',
      });
      socket.serverClose(4410, 'peer unreachable');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('same private Wi-Fi');
    expect(screen.getByRole('alert')).toHaveTextContent('macOS firewall');
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('marks a relayed room live only after the host connected event arrives', async () => {
    const user = userEvent.setup();
    const invitation = createRoomCode('192.168.1.42');
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    await user.type(screen.getByLabelText('Your name'), 'Asha');
    await user.type(screen.getByLabelText('Room code'), invitation);
    await user.click(screen.getByRole('button', { name: 'Join conversation' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getAllByText('Connecting through this Mac to room host').length)
      .toBeGreaterThan(0);

    act(() => socket.receive({
      type: 'connected',
      client_id: new URL(socket.url).searchParams.get('client_id'),
      room_id: invitation,
      participants: [{ client_id: 'creator-1', display_name: 'Mira' }],
      messages: historyPayload.messages,
    }));
    expect(await screen.findByText('I am already here.')).toBeVisible();
    expect(screen.getAllByText('Connected through this Mac to room host').length)
      .toBeGreaterThan(0);
    await waitForEncryptedComposer();
  });

  it('loads history, connects, sends the exact envelope, and receives messages', async () => {
    const { user, socket } = await enterKnownRoom();
    expect(fetch).toHaveBeenCalledWith(
      '/api/rooms/ROOM-42/messages?limit=50',
      expect.any(Object),
    );
    expect(screen.getByText('I am already here.')).toBeVisible();

    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });

    await waitForEncryptedComposer();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'Hello Mira{enter}');
    await waitFor(() => expect(
      socket.sent.some((packet) => JSON.parse(packet).type === 'encrypted_message'),
    ).toBe(true));
    const packets = socket.sent.map((packet) => JSON.parse(packet) as Record<string, unknown>);
    const hello = packets.find((packet) => packet.type === 'e2ee_hello');
    const sentMessage = packets.find((packet) => packet.type === 'encrypted_message');
    expect(sentMessage).toMatchObject({
      type: 'encrypted_message',
      version: 'e2ee-v1',
      algorithm: 'AES-256-GCM',
    });
    expect(sentMessage).not.toHaveProperty('text');
    expect(sentMessage?.client_message_id).toEqual(expect.any(String));
    expect(screen.getByText('Hello Mira')).toBeVisible();

    const peerContext = await deriveContext(
      peerIdentity,
      String(hello?.public_key),
      String(hello?.public_key_id),
      'ROOM-42',
    );
    await expect(decryptText(peerContext, {
      version: 'e2ee-v1',
      keyId: String(sentMessage?.key_id),
      senderKeyId: String(hello?.public_key_id),
      iv: String(sentMessage?.iv),
      ciphertext: String(sentMessage?.ciphertext),
    }, {
      roomId: 'ROOM-42',
      senderId: new URL(socket.url).searchParams.get('client_id') || '',
      senderName: 'Asha',
      clientMessageId: String(sentMessage?.client_message_id),
    })).resolves.toBe('Hello Mira');

    act(() => {
      socket.receive({
        type: 'error',
        code: 'message_too_long',
        message: 'Message exceeds the configured server limit',
        client_message_id: sentMessage?.client_message_id,
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('configured server limit');
    expect(screen.getByRole('button', { name: /Not sent.*Retry/i })).toBeVisible();
    const sendsBeforeRetry = socket.sent.length;
    await user.click(screen.getByRole('button', { name: /Not sent.*Retry/i }));
    expect(screen.queryByText('Message exceeds the configured server limit')).not.toBeInTheDocument();
    expect(socket.sent).toHaveLength(sendsBeforeRetry + 1);
    expect(JSON.parse(socket.sent.at(-1) || '{}')).toMatchObject({
      type: 'encrypted_message',
      iv: sentMessage?.iv,
      ciphertext: sentMessage?.ciphertext,
    });

    const incoming = await encryptText(peerContext, 'Nice to meet you.', {
      roomId: 'ROOM-42',
      senderId: 'guest-2',
      senderName: 'Mira',
      clientMessageId: 'incoming-2',
    });
    act(() => {
      socket.receive({
        type: 'encrypted_message',
        message: {
          id: '2',
          client_message_id: 'incoming-2',
          sender_id: 'guest-2',
          sender_name: 'Mira',
          sent_at: '2026-09-08T09:31:00.000Z',
          kind: 'encrypted_message',
          version: incoming.version,
          algorithm: 'AES-256-GCM',
          key_id: incoming.keyId,
          sender_key_id: incoming.senderKeyId,
          iv: incoming.iv,
          ciphertext: incoming.ciphertext,
        },
      });
    });
    expect(await screen.findByText('Nice to meet you.')).toBeVisible();
    expect(screen.getByText('Hello Mira')).toBeVisible();
  });

  it('sends hi through the live demo and shows the actual cipher and backend acknowledgement', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({ type: 'connected', client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42', participants: [{ client_id: 'guest-2', display_name: 'Mira' }], messages: [] });
    });
    await waitForEncryptedComposer();
    await user.click(screen.getByRole('button', { name: 'Encryption demo' }));
    const panel = screen.getByRole('dialog', { name: 'See what happens to “hi”' });
    await user.click(within(panel).getByRole('button', { name: 'Live chat' }));
    expect(within(panel).getByRole('textbox', { name: 'Your message' })).toHaveValue('hi');
    await user.click(within(panel).getByRole('button', { name: 'Send & watch' }));
    await waitFor(() => expect(socket.sent.some(packet => JSON.parse(packet).type === 'encrypted_message')).toBe(true));
    const sent = socket.sent.map(packet => JSON.parse(packet) as Record<string, unknown>)
      .find(packet => packet.type === 'encrypted_message')!;
    const hello = socket.sent.map(packet => JSON.parse(packet) as Record<string, unknown>)
      .find(packet => packet.type === 'e2ee_hello')!;
    expect(sent).not.toHaveProperty('text');
    expect(within(panel).getByText(String(sent.ciphertext))).toBeVisible();
    expect(within(panel).getByText('Waiting for the backend acknowledgement.')).toBeVisible();
    expect(screen.queryByText('Relayed')).not.toBeInTheDocument();
    const peerContext = await deriveContext(peerIdentity, String(hello.public_key), String(hello.public_key_id), 'ROOM-42');
    await expect(decryptText(peerContext, {
      version: 'e2ee-v1', keyId: String(sent.key_id), senderKeyId: String(hello.public_key_id),
      iv: String(sent.iv), ciphertext: String(sent.ciphertext),
    }, {
      roomId: 'ROOM-42', senderId: new URL(socket.url).searchParams.get('client_id') || '',
      senderName: 'Asha', clientMessageId: String(sent.client_message_id),
    })).resolves.toBe('hi');
    act(() => socket.receive({ type: 'message_ack', client_message_id: sent.client_message_id,
      message_id: '42', sent_at: '2026-11-13T09:30:00Z', duplicate: false }));
    expect(screen.getByText('Relayed')).toHaveAccessibleName('Accepted by the server for encrypted relay. This does not confirm your partner decrypted it.');
    expect(screen.getByText('Relayed')).toHaveAttribute('title', 'Accepted by the server for encrypted relay. This does not confirm your partner decrypted it.');
    expect(within(panel).getByText('Backend accepted the encrypted message for storage and relay.')).toBeVisible();
    expect(within(panel).getByText('No successful local decryption observed')).toBeVisible();
    await user.click(within(panel).getByText('Inspect the actual encrypted envelope'));
    expect(within(panel).getByText(/"message_id": "42"/)).toHaveTextContent('2026-11-13T09:30:00Z');
    expect(within(panel).queryByText('Learning key · never used for chat')).not.toBeInTheDocument();
  });

  it('shows Encrypting until an outgoing ciphertext envelope exists', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();

    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
    let releaseEncryption: (() => void) | undefined;
    const encryptionGate = new Promise<void>((resolve) => {
      releaseEncryption = resolve;
    });
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      await encryptionGate;
      return originalEncrypt(algorithm, key, data);
    });

    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'Hold this envelope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    const message = screen.getByText('Hold this envelope').closest('.message-content');
    expect(message).not.toBeNull();
    expect(within(message as HTMLElement).getByText('Encrypting')).toBeVisible();
    expect(within(message as HTMLElement).queryByText('Encrypted')).not.toBeInTheDocument();

    await act(async () => {
      releaseEncryption?.();
      await encryptionGate;
    });
    await waitFor(() => {
      expect(within(message as HTMLElement).getByText('Encrypted')).toBeVisible();
    });
  });

  it('keeps the session-only private-key fallback visible without opening details', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();

    const warning = screen.getByRole('status', { name: 'Session-only encryption key warning' });
    expect(warning).toHaveTextContent('Session-only encryption key');
    expect(warning).toHaveTextContent('Refreshing can make earlier encrypted messages unavailable');
    expect(within(warning).getByRole('button', { name: 'View details' })).toBeVisible();
  });

  it('never renders malformed encrypted input as its supplied fallback text', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();

    act(() => socket.receive({
      type: 'encrypted_message',
      message: {
        id: 'malformed-1',
        client_message_id: 'malformed-client-1',
        sender_id: 'guest-2',
        sender_name: 'Mira',
        kind: 'encrypted_message',
        text: 'A forged fallback must never render',
        version: 'e2ee-v1',
        algorithm: 'AES-256-GCM',
        key_id: 'bad-key',
        sender_key_id: 'bad-sender-key',
        iv: 'bad-iv',
        ciphertext: 'bad-ciphertext',
      },
    }));

    expect(screen.queryByText('A forged fallback must never render')).not.toBeInTheDocument();
  });

  it('fails closed when a live plaintext chat packet arrives in an encrypted room', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();

    act(() => socket.receive({
      type: 'message',
      message: {
        id: 'plaintext-1',
        client_message_id: 'plaintext-client-1',
        sender_id: 'guest-2',
        sender_name: 'Mira',
        kind: 'message',
        text: 'A live plaintext downgrade must never render',
      },
    }));
    act(() => socket.receive({
      type: 'chat_message',
      message: {
        id: 'plaintext-system-1',
        client_message_id: 'plaintext-system-client-1',
        sender_id: 'system',
        sender_name: 'System',
        kind: 'system',
        text: 'A system label must not bypass live plaintext blocking',
      },
    }));

    expect(screen.queryByText('A live plaintext downgrade must never render')).not.toBeInTheDocument();
    expect(screen.queryByText('A system label must not bypass live plaintext blocking')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Encryption failed.*Open encryption details/i }))
      .toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  });

  it('retains an oversized UTF-8 draft and explains why it was not sent', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();

    const oversized = '界'.repeat(1_500);
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: oversized } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(composer).toHaveValue(oversized);
    expect(screen.queryByText(oversized, { selector: '.message-bubble p' })).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/too large.*UTF-8|4,096.*bytes/i);
  });

  it('shows the live encryption path and records an explicit safety-code match', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();

    await user.click(screen.getByRole('button', { name: /Encrypted · unverified.*Open encryption details/i }));
    const panel = screen.getByRole('dialog', { name: 'Security details' });
    expect(within(panel).getByLabelText('Safety code')).toHaveTextContent(/^\d{4} \d{4} \d{4}$/);
    expect(screen.getAllByRole('button', { name: 'Encryption demo' })).toHaveLength(1);
    expect(screen.queryByText('Message protection')).not.toBeInTheDocument();
    expect(screen.queryByText('How protection works')).not.toBeInTheDocument();
    expect(within(panel).getByText('Created in this browser')).not.toBeVisible();
    await user.click(within(panel).getByText('Technical details'));
    expect(within(panel).getByText('Created in this browser')).toBeVisible();
    expect(within(panel).getByText('Paired with your partner')).toBeVisible();
    expect(within(panel).getByText('Separated by direction')).toBeVisible();
    expect(within(panel).getByText('Sealed before sending')).toBeVisible();
    expect(within(panel).getByText('Relayed as ciphertext')).toBeVisible();

    await user.click(within(panel).getByRole('checkbox'));
    await user.click(within(panel).getByRole('button', { name: 'Codes match' }));
    expect(screen.getByRole('button', { name: /Encrypted · verified.*Open encryption details/i }))
      .toBeVisible();
    expect(within(panel).getByText('Verified on this browser')).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: /Encrypted · unverified.*Open encryption details/i }))
      .toBeVisible();
  });

  it('rejects tampered ciphertext, reveals no partial plaintext, and pauses sending', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();
    const packets = socket.sent.map((packet) => JSON.parse(packet) as Record<string, unknown>);
    const hello = packets.find((packet) => packet.type === 'e2ee_hello');
    const peerContext = await deriveContext(
      peerIdentity,
      String(hello?.public_key),
      String(hello?.public_key_id),
      'ROOM-42',
    );
    const incoming = await encryptText(peerContext, 'This must never appear after tampering', {
      roomId: 'ROOM-42',
      senderId: 'guest-2',
      senderName: 'Mira',
      clientMessageId: 'tampered-1',
    });
    const replacement = incoming.ciphertext.endsWith('A') ? 'B' : 'A';

    act(() => socket.receive({
      type: 'encrypted_message',
      message: {
        id: 'tampered-server-1',
        client_message_id: 'tampered-1',
        sender_id: 'guest-2',
        sender_name: 'Mira',
        sent_at: '2026-09-08T09:32:00.000Z',
        kind: 'encrypted_message',
        version: incoming.version,
        algorithm: 'AES-256-GCM',
        key_id: incoming.keyId,
        sender_key_id: incoming.senderKeyId,
        iv: incoming.iv,
        ciphertext: `${incoming.ciphertext.slice(0, -1)}${replacement}`,
      },
    }));

    expect(await screen.findByText('This encrypted message could not be authenticated.')).toBeVisible();
    expect(screen.queryByText('This must never appear after tampering')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Encryption failed.*Open encryption details/i })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  });

  it('marks encrypted history from an unavailable key instead of leaving it decrypting forever', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [{
          id: 'old-encrypted-1',
          client_message_id: 'old-encrypted-client-1',
          sender_id: 'guest-2',
          sender_name: 'Mira',
          sent_at: '2026-09-08T09:20:00.000Z',
          kind: 'encrypted_message',
          version: 'e2ee-v1',
          algorithm: 'AES-256-GCM',
          key_id: 'A'.repeat(43),
          sender_key_id: 'B'.repeat(43),
          iv: 'C'.repeat(16),
          ciphertext: 'D'.repeat(23),
        }],
        e2ee_required: true,
      });
    });

    expect(await screen.findByText('Earlier encrypted message unavailable. This browser does not have its matching key.'))
      .toBeVisible();
    expect(screen.queryByText('Decrypting message…')).not.toBeInTheDocument();
    expect(screen.getByText('Not authenticated')).toBeVisible();
  });

  it('pauses on a changed peer key until the new key is explicitly accepted', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();
    const changedPeer = await generateIdentity();
    act(() => socket.receive({
      type: 'e2ee_public_key',
      client_id: 'guest-2',
      display_name: 'Mira',
      version: 'e2ee-v1',
      algorithm: 'ECDH-P256',
      public_key_id: changedPeer.publicKeyId,
      public_key: changedPeer.publicKey,
    }));

    expect(await screen.findByRole('button', { name: /Device key changed.*Open encryption details/i }))
      .toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Device key changed.*Open encryption details/i }));
    await user.click(screen.getByRole('button', { name: 'Accept new key, keep unverified' }));
    await waitForEncryptedComposer();
  });

  it('detects a changed peer key after leaving and reopening the same room', async () => {
    const firstVisit = await enterKnownRoom();
    act(() => {
      firstVisit.socket.open();
      firstVisit.socket.receive({
        type: 'connected',
        client_id: new URL(firstVisit.socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();
    firstVisit.unmount();

    peerIdentity = await generateIdentity();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Join room' }));
    expect(screen.getByLabelText('Your name')).toHaveValue('Asha');
    expect(screen.getByLabelText('Room code')).toHaveValue('ROOM-42');
    await user.click(screen.getByRole('button', { name: 'Join conversation' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reopenedSocket = MockWebSocket.instances[1];
    act(() => {
      reopenedSocket.open();
      reopenedSocket.receive({
        type: 'connected',
        client_id: new URL(reopenedSocket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });

    expect(await screen.findByRole('button', { name: /Device key changed.*Open encryption details/i }))
      .toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  });

  it('rotates the local identity after IV reuse and requires safety-code review', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitForEncryptedComposer();
    const firstHello = socket.sent
      .map((packet) => JSON.parse(packet) as Record<string, unknown>)
      .find((packet) => packet.type === 'e2ee_hello');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Rotate this key{enter}');
    await waitFor(() => expect(
      socket.sent.some((packet) => JSON.parse(packet).type === 'encrypted_message'),
    ).toBe(true));
    const encrypted = socket.sent
      .map((packet) => JSON.parse(packet) as Record<string, unknown>)
      .find((packet) => packet.type === 'encrypted_message');
    act(() => socket.receive({
      type: 'error',
      code: 'e2ee_iv_reuse',
      message: 'This AES-GCM IV was already used with the current sending key',
      client_message_id: encrypted?.client_message_id,
    }));

    const failedBadge = await screen.findByRole('button', { name: /Encryption failed.*Open encryption details/i });
    await user.click(failedBadge);
    await user.click(screen.getByRole('button', { name: 'Retry encryption' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));

    const rotatedSocket = MockWebSocket.instances[1];
    act(() => {
      rotatedSocket.open();
      rotatedSocket.receive({
        type: 'connected',
        client_id: new URL(rotatedSocket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: [],
        e2ee_required: true,
      });
    });
    await waitFor(() => expect(
      rotatedSocket.sent.some((packet) => JSON.parse(packet).type === 'e2ee_hello'),
    ).toBe(true));
    const rotatedHello = rotatedSocket.sent
      .map((packet) => JSON.parse(packet) as Record<string, unknown>)
      .find((packet) => packet.type === 'e2ee_hello');

    expect(rotatedHello?.public_key_id).not.toBe(firstHello?.public_key_id);
    expect(await screen.findByRole('button', { name: /Device key changed.*Open encryption details/i }))
      .toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Accept new key, keep unverified' }));
    await waitForEncryptedComposer();
  });

  it('copies the room code and keeps encryption status visible in chat', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => socket.open());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    expect(screen.getByRole('button', { name: /Setting up encryption.*Open encryption details/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Copy room code' }));
    expect(writeText).toHaveBeenCalledWith('ROOM-42');
    expect(screen.getByText('Copied')).toBeVisible();
  });

  it('treats a full room as terminal instead of reconnecting', async () => {
    const { socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'error',
        code: 'room_full',
        message: 'This room already has two distinct clients',
      });
      socket.serverClose(4403, 'This room already has two distinct clients');
    });
    expect(await screen.findByText('This room already has two distinct clients')).toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('runs one authoritative BB84 experiment and renders its bounded teaching result', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });

    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));
    expect(screen.getByRole('dialog', { name: 'BB84 Security Lab' })).toBeVisible();
    expect(screen.getByText('A software experiment, separate from your chat')).toBeVisible();
    await waitForEncryptedComposer();
    const protectionMap = screen.getByRole('region', { name: 'How does this protect our chat?' });
    expect(within(protectionMap).getByText('Active')).toBeVisible();
    expect(within(protectionMap).getByText('Not connected')).toBeVisible();
    expect(within(protectionMap).getByText(/currently using ECDH and AES-256-GCM/)).toBeVisible();
    await user.click(screen.getByText('Experiment settings · advanced'));

    await user.selectOptions(screen.getByRole('combobox', { name: /Bits to prepare/i }), '256');
    fireEvent.change(screen.getByRole('slider', { name: 'Background noise percentage' }), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Eve’s interception percentage' }), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Sample to check percentage' }), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Acceptable error limit percentage' }), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Reproducible seed' }), {
      target: { value: '4242' },
    });
    await user.click(screen.getByRole('button', { name: /Start BB84 Experiment|Run another experiment/ }));

    const packets = socket.sent.map((packet) => JSON.parse(packet) as Record<string, unknown>);
    expect(packets.find((packet) => packet.type === 'bb84_start')).toEqual({
      type: 'bb84_start',
      qubit_count: 256,
      noise_probability: 0.04,
      intercept_probability: 0.5,
      sample_ratio: 0.3,
      qber_threshold: 0.12,
      seed: 4242,
    });
    expect(screen.getByText('Running the software model')).toBeVisible();

    act(() => socket.receive({
      type: 'bb84_result',
      session_id: 'sim_0123456789abcdef01234567',
      started_by: new URL(socket.url).searchParams.get('client_id'),
      created_at: '2026-09-13T12:00:00Z',
      simulation_only: true,
      chat_encryption_active: false,
      config: {
        qubit_count: 256,
        noise_probability: 0.04,
        intercept_probability: 0.5,
        sample_ratio: 0.3,
        qber_threshold: 0.12,
        seed: 4242,
      },
      metrics: {
        transmitted: 256,
        intercepted: 126,
        sifted: 125,
        sample: 38,
        mismatches: 4,
        qber: 4 / 38,
        retained: 87,
      },
      decision: { status: 'accepted', reason: 'qber_within_threshold' },
      post_processing: insufficientEntropyPostProcessing(87, true),
      trace: [{
        index: 0,
        alice_basis: 'Z',
        bob_basis: 'Z',
        basis_match: true,
        intercepted: true,
        sampled: true,
        sample_comparison: 'match',
      }, {
        index: 1,
        alice_basis: 'Z',
        bob_basis: 'X',
        basis_match: false,
        intercepted: false,
        sampled: false,
        sample_comparison: null,
      }],
    }));

    await user.click(await screen.findByText('Show technical details'));
    expect(await screen.findByText('Sample accepted')).toBeVisible();
    expect(screen.getByText('10.53%')).toBeVisible();
    expect(screen.getByText('2 selected transmissions, with no raw bit values')).toBeVisible();
    expect(screen.getByRole('region', { name: 'From accepted sample to discarded material' })).toBeVisible();
    expect(screen.getByText('Not enough estimated secret information')).toBeVisible();
    expect(screen.getByText(/Try a larger or cleaner run; HKDF cannot create missing entropy/i)).toBeVisible();
    expect(screen.getByText('Stopped here')).toBeVisible();
    expect(screen.getAllByText('Not run')).toHaveLength(2);
    expect(screen.getByText('Temporary material is not directly serialized or retained')).toBeVisible();
    expect(screen.getByText(/seeded teaching run is predictable/i)).toBeVisible();
    expect(screen.getByText(/can be reconstructed from the shared seed, settings, room and session context/i)).toBeVisible();
    const explainers = screen.getAllByText('Explain these metrics');
    expect(explainers).toHaveLength(4);
    const reconciliationHelp = explainers[0].closest('details');
    expect(reconciliationHelp).not.toHaveAttribute('open');
    await user.click(explainers[0]);
    expect(reconciliationHelp).toHaveAttribute('open');
    expect(screen.getByText(/Candidate bits left after the disclosed QBER sample/i)).toBeVisible();
    const resultsRegion = screen.getByRole('region', { name: 'BB84 experiment result' });
    expect(resultsRegion).not.toHaveAttribute('aria-live');
    expect(within(screen.getByRole('region', { name: 'From accepted sample to discarded material' })).getByRole('alert')).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it('shows all four Phase 3 stages when post-processing completes', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));

    act(() => socket.receive({
      ...bb84BasePayload,
      config: {
        ...bb84BasePayload.config,
        qubit_count: 1024,
        noise_probability: 0,
        intercept_probability: 0,
      },
      metrics: {
        transmitted: 1024,
        intercepted: 0,
        sifted: 600,
        sample: 150,
        mismatches: 0,
        qber: 0,
        retained: 450,
      },
      post_processing: completedPostProcessing(450),
      trace: [{
        index: 0,
        alice_basis: 'Z',
        bob_basis: 'Z',
        basis_match: true,
        intercepted: false,
        sampled: true,
        sample_comparison: 'match',
      }],
    }));

    await user.click(await screen.findByText('Show technical details'));
    const panel = await screen.findByRole('region', {
      name: 'From accepted sample to discarded material',
    });
    expect(within(panel).getByText('Post-processing model completed')).toBeVisible();
    expect(within(panel).getByText('Chat encryption: Independent')).toBeVisible();
    expect(within(panel).getByText(/Chat key setup is independent/i)).toBeVisible();
    expect(within(panel).getByText(/simulation never supplies or changes the live chat keys/i)).toBeVisible();
    expect(within(panel).getAllByText('Completed')).toHaveLength(4);
    expect(within(panel).getByText('toeplitz-universal-hash-v1')).toBeVisible();
    expect(within(panel).getByText('hkdf-sha256-v1')).toBeVisible();
    expect(within(panel).getByText(/Expansion does not add entropy or security strength/i)).toBeVisible();
    const explainers = within(panel).getAllByText('Explain these metrics');
    expect(explainers).toHaveLength(4);
    expect(within(panel).getByRole('status')).toHaveAttribute('aria-atomic', 'true');
    const close = screen.getByRole('button', { name: 'Close protocol lab' });
    close.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(explainers.at(-1)).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it.each([
    {
      label: 'reconciliation failure',
      postProcessing: reconciliationFailurePostProcessing(200),
      outcome: 'Reconciliation could not be verified',
      completed: 0,
      notRun: 3,
    },
    {
      label: 'confirmation failure',
      postProcessing: confirmationFailurePostProcessing(200),
      outcome: 'Internal confirmation check failed',
      completed: 2,
      notRun: 1,
    },
    {
      label: 'derivation failure',
      postProcessing: derivationFailurePostProcessing(200),
      outcome: 'Internal derivation check failed',
      completed: 3,
      notRun: 0,
    },
  ])('renders the safe stage sequence for $label', async ({
    postProcessing,
    outcome,
    completed,
    notRun,
  }) => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));

    act(() => socket.receive({
      ...bb84BasePayload,
      config: {
        ...bb84BasePayload.config,
        qubit_count: 512,
        noise_probability: 0,
        intercept_probability: 0,
      },
      metrics: {
        transmitted: 512,
        intercepted: 0,
        sifted: 267,
        sample: 67,
        mismatches: 0,
        qber: 0,
        retained: 200,
      },
      post_processing: postProcessing,
    }));

    await user.click(await screen.findByText('Show technical details'));
    const panel = await screen.findByRole('region', {
      name: 'From accepted sample to discarded material',
    });
    expect(within(panel).getByText(outcome)).toBeVisible();
    expect(within(panel).queryAllByText('Completed')).toHaveLength(completed);
    expect(within(panel).getAllByText('Stopped here')).toHaveLength(1);
    expect(within(panel).queryAllByText('Not run')).toHaveLength(notRun);
    const derivationCard = within(panel).getByText('Derive and discard').closest('article');
    expect(derivationCard).not.toBeNull();
    expect(within(derivationCard as HTMLElement).getByText('0 bits')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it('sends the demo-friendly zero-noise settings without requiring adjustments', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));
    await user.click(screen.getByRole('button', { name: /Start BB84 Experiment|Run another experiment/ }));

    const packets = socket.sent.map((packet) => JSON.parse(packet) as Record<string, unknown>);
    expect(packets.find((packet) => packet.type === 'bb84_start')).toEqual({
      type: 'bb84_start',
      qubit_count: 512,
      noise_probability: 0,
      intercept_probability: 0,
      sample_ratio: 0.25,
      qber_threshold: 0.11,
      seed: null,
    });
  });

  it('captures settings before deferred React updates and keeps the result intact', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({ type: 'connected', client_id: new URL(socket.url).searchParams.get('client_id'), room_id: 'ROOM-42', participants: [], messages: [] });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));
    act(() => socket.receive(bb84BasePayload));
    await screen.findByText('Experiment stopped');
    const select = screen.getByRole('combobox', { name: /Bits to prepare/ });
    act(() => {
      fireEvent.change(screen.getByRole('slider', { name: 'Eve’s interception percentage' }), { target: { value: '50' } });
      fireEvent.change(select, { target: { value: '1024' } });
      fireEvent.change(select, { target: { value: '128' } });
    });
    expect(select).toHaveValue('128');
    expect(screen.getByText('Experiment stopped')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run another experiment' }));
    const command = socket.sent.map((packet) => JSON.parse(packet) as Record<string, unknown>).find((packet) => packet.type === 'bb84_start');
    expect(command).toMatchObject({ qubit_count: 128, intercept_probability: 0.5 });
  });

  it('keeps a partner-run result configuration separate from the local controls', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));

    act(() => socket.receive({
      ...bb84BasePayload,
      config: {
        qubit_count: 128,
        noise_probability: 0.025,
        intercept_probability: 0.75,
        sample_ratio: 0.4,
        qber_threshold: 0.095,
        seed: 4242,
      },
      metrics: {
        transmitted: 128,
        intercepted: 96,
        sifted: 32,
        sample: 13,
        mismatches: 1,
        qber: 1 / 13,
        retained: 19,
      },
      post_processing: insufficientEntropyPostProcessing(19, true),
    }));

    await user.click(await screen.findByText('Show technical details'));
    const summary = await screen.findByRole('region', { name: 'Recorded BB84 session settings' });
    expect(within(summary).getByText('sim_aabbccddeeff001122334455')).toBeVisible();
    expect(within(summary).getByText('Mira')).toBeVisible();
    expect(within(summary).getByText('128')).toBeVisible();
    expect(within(summary).getByText('2.5%')).toBeVisible();
    expect(within(summary).getByText('75%')).toBeVisible();
    expect(within(summary).getByText('40%')).toBeVisible();
    expect(within(summary).getByText('9.5%')).toBeVisible();
    expect(within(summary).getByText('4242')).toBeVisible();

    expect(screen.getByRole('combobox', { name: /Bits to prepare/i })).toHaveValue('512');
    await user.click(screen.getByText('Experiment settings · advanced'));
    expect(screen.getByRole('slider', { name: 'Background noise percentage' })).toHaveValue('0');
    expect(screen.getByText(/Changing the controls on the left does not alter the recorded run/i)).toBeVisible();
    expect(screen.getByText(/Simulator ground truth: intercept flag, not directly observable/i)).toBeVisible();
    expect(screen.getByRole('columnheader', { name: /Intercept flag simulator truth/i })).toBeVisible();
  });

  it('shows an aborted decision and keeps a busy simulation error recoverable', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));

    act(() => socket.receive({
      ...bb84BasePayload,
      config: {
        ...bb84BasePayload.config,
        noise_probability: 0.2,
        intercept_probability: 1,
      },
      metrics: {
        transmitted: 128,
        intercepted: 128,
        sifted: 64,
        sample: 16,
        mismatches: 4,
        qber: 0.25,
        retained: 48,
      },
      decision: { status: 'aborted', reason: 'qber_above_threshold' },
      post_processing: skippedPostProcessing(48),
    }));

    await user.click(await screen.findByText('Show technical details'));
    expect(await screen.findByText('Sample rejected')).toBeVisible();
    expect(screen.getByText('25.00%')).toBeVisible();
    expect(screen.getByText(/exceeded the selected QBER limit/i)).toBeVisible();
    expect(screen.getByText('Post-processing was not started')).toBeVisible();
    expect(screen.getAllByText('Not run')).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: /Start BB84 Experiment|Run another experiment/ }));
    act(() => socket.receive({
      type: 'error',
      code: 'bb84_busy',
      message: 'A BB84 simulation is already running for this room',
    }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already running for this room');
    expect(screen.getByRole('button', { name: /Start BB84 Experiment|Run another experiment/ })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it('renders an insufficient-sifted-bits decision with QBER unavailable', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));

    act(() => socket.receive({
      ...bb84BasePayload,
      session_id: 'sim_insufficient000000000001',
      metrics: {
        transmitted: 128,
        intercepted: 0,
        sifted: 0,
        sample: 0,
        mismatches: 0,
        qber: null,
        retained: 0,
      },
      decision: { status: 'aborted', reason: 'insufficient_sifted_bits' },
      post_processing: skippedPostProcessing(0),
      trace: [],
    }));

    await user.click(await screen.findByText('Show technical details'));
    expect(await screen.findByText('Sample rejected')).toBeVisible();
    expect(screen.getByText(/Too few matching-basis measurements remained/i)).toBeVisible();
    expect(screen.getByText('N/A')).toBeVisible();
    expect(screen.getByText('0 ÷ 0 = undefined')).toBeVisible();
    expect(screen.getByText('Post-processing was not started')).toBeVisible();
  });

  it('labels a received run without a seed as random', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));

    act(() => socket.receive(bb84BasePayload));

    await user.click(await screen.findByText('Show technical details'));
    const summary = await screen.findByRole('region', { name: 'Recorded BB84 session settings' });
    expect(within(summary).getByText('Seed')).toBeVisible();
    expect(within(summary).getByText('Random')).toBeVisible();
  });

  it('times out a missing simulation response without breaking chat', async () => {
    const { user, socket } = await enterKnownRoom();
    act(() => {
      socket.open();
      socket.receive({
        type: 'connected',
        client_id: new URL(socket.url).searchParams.get('client_id'),
        room_id: 'ROOM-42',
        participants: [{ client_id: 'guest-2', display_name: 'Mira' }],
        messages: historyPayload.messages,
      });
    });
    await waitForEncryptedComposer();
    await user.click(screen.getByRole('button', { name: 'Open BB84 Security Lab' }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /Start BB84 Experiment|Run another experiment/ }));
    act(() => vi.advanceTimersByTime(10_000));

    expect(screen.getByRole('alert')).toHaveTextContent('did not return a result within 10 seconds');
    expect(screen.getByRole('button', { name: /Start BB84 Experiment|Run another experiment/ })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it('traps and restores keyboard focus for the protocol lab dialog', async () => {
    const { user } = await enterKnownRoom();
    const trigger = screen.getByRole('button', { name: 'Open BB84 Security Lab' });
    await user.click(trigger);
    const close = screen.getByRole('button', { name: 'Close protocol lab' });
    expect(close).toHaveFocus();

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByText('Experiment settings · advanced')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'BB84 Security Lab' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
