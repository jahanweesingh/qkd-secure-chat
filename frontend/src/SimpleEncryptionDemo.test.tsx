import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleEncryptionDemo, type SimpleEncryptionDemoProps } from './SimpleEncryptionDemo';
import type { LearningEncryptionResult } from './learningCrypto';
import type { ChatMessage } from './types';
import type { SecurityTraceEvent, SecurityTraceKind } from './securityTrace';

const cryptoDemo = vi.hoisted(() => vi.fn());
vi.mock('./learningCrypto', () => ({ LEARNING_MAX_BYTES: 512, runLearningEncryption: cryptoDemo }));

const example: LearningEncryptionResult = {
  plaintext: 'hi', decrypted: 'hi', ciphertextHex: 'a1b2', tagHex: 'c3'.repeat(16),
  combinedCiphertextHex: 'a1b2' + 'c3'.repeat(16), ivHex: 'd4'.repeat(12),
  alicePrivateHex: 'a5'.repeat(32), bobPrivateHex: 'b6'.repeat(32),
  alicePublicHex: '04' + 'a7'.repeat(64), bobPublicHex: '04' + 'b8'.repeat(64),
  sharedSecretHex: 'c9'.repeat(32), aliceToBobKeyHex: 'd0'.repeat(32),
  bobToAliceKeyHex: 'e1'.repeat(32), hkdfSaltHex: 'f2'.repeat(32),
  aliceToBobInfo: 'DEMO-ALICE-BOB', bobToAliceInfo: 'DEMO-BOB-ALICE',
  aad: 'DEMO-AAD', plaintextBytes: 2,
};

function props(overrides: Partial<SimpleEncryptionDemoProps> = {}): SimpleEncryptionDemoProps {
  return { messages: [], currentClientId: 'alice', events: [],
    connection: { state: 'connected', attempt: 0, error: null, nextRetrySeconds: null },
    encryption: { state: 'encrypted_unverified', canSend: true, activeKeyMode: 'ecdh', verificationCode: '1234 5678 9012',
      verifiedAt: null, peerName: 'Bob', localKeyId: 'LOCAL-ID', peerKeyId: 'PEER-ID',
      sessionKeyId: 'PAIR-ID', keyStorage: 'device', error: null },
    onSend: vi.fn(() => true), ...overrides };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'server-1', clientMessageId: 'client-1', senderId: 'alice', senderName: 'Alice',
    kind: 'message', sentAt: '2026-11-13T10:00:00Z', text: 'hi', status: 'sent', security: 'encrypted',
    encryption: { version: 'e2ee-v1', algorithm: 'AES-256-GCM', keyId: 'A'.repeat(43),
      senderKeyId: 'B'.repeat(43), iv: 'C'.repeat(16), ciphertext: 'D'.repeat(24) }, ...overrides };
}

function event(kind: SecurityTraceKind, extra: Partial<SecurityTraceEvent> = {}): SecurityTraceEvent {
  return { id: `${kind}-1`, kind, timestamp: 1_700_000_000_000, source: 'live',
    direction: 'outgoing', messageId: 'client-1', ...extra };
}

beforeEach(() => { cryptoDemo.mockReset(); cryptoDemo.mockResolvedValue(example); });

describe('simple encryption example', () => {
  it('starts with a local hi example and shows actual returned ciphertext/key without sending a chat', async () => {
    const user = userEvent.setup(); const parameters = props();
    render(<SimpleEncryptionDemo {...parameters} />);
    expect(screen.getByRole('button', { name: 'Learn with keys' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Your message' })).toHaveValue('hi');
    expect(screen.queryByText(example.aliceToBobKeyHex)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Encrypt & decrypt' }));
    expect(cryptoDemo).toHaveBeenCalledWith('hi');
    expect(parameters.onSend).not.toHaveBeenCalled();
    expect(screen.getByText(example.combinedCiphertextHex)).toBeVisible();
    expect(screen.getAllByText('hi', { selector: 'p' })).toHaveLength(2);
    expect(screen.getByText('Learning key · never used for chat')).toBeVisible();
    expect(screen.getAllByText(example.aliceToBobKeyHex)[0]).toBeVisible();
    expect(screen.getByText(/Real encryption, entirely in this browser/)).toBeVisible();
    expect(screen.queryByText(/Backend accepted/)).not.toBeInTheDocument();
    await user.click(screen.getByText('See all example keys and values'));
    expect(screen.getByText(example.alicePrivateHex)).toBeVisible();
    expect(screen.getByText(example.sharedSecretHex)).toBeVisible();
  });

  it('removes completed example keys/results when the text is edited', async () => {
    const user = userEvent.setup(); render(<SimpleEncryptionDemo {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Encrypt & decrypt' }));
    await user.type(screen.getByRole('textbox', { name: 'Your message' }), '!');
    expect(screen.queryByText(example.combinedCiphertextHex)).not.toBeInTheDocument();
    expect(screen.queryByText(example.alicePrivateHex)).not.toBeInTheDocument();
    expect(screen.queryByText('Learning key · never used for chat')).not.toBeInTheDocument();
  });

  it('discards a pending result after mode change and prevents duplicate submissions while busy', async () => {
    let complete!: (value: LearningEncryptionResult) => void;
    cryptoDemo.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const user = userEvent.setup(); const parameters = props();
    render(<SimpleEncryptionDemo {...parameters} />);
    await user.click(screen.getByRole('button', { name: 'Encrypt & decrypt' }));
    expect(screen.getByRole('button', { name: 'Encrypting…' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('textbox', { name: 'Your message' }).closest('form')!);
    expect(cryptoDemo).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Live chat' }));
    await act(async () => { complete(example); });
    expect(screen.queryByText(example.combinedCiphertextHex)).not.toBeInTheDocument();
    expect(screen.queryByText('Learning key · never used for chat')).not.toBeInTheDocument();
    expect(parameters.onSend).not.toHaveBeenCalled();
  });

  it('shows a safe recoverable crypto error without leaking the raw exception', async () => {
    cryptoDemo.mockRejectedValueOnce(new Error('SECRET_EXCEPTION_MATERIAL'));
    const user = userEvent.setup(); const { container } = render(<SimpleEncryptionDemo {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Encrypt & decrypt' }));
    expect(screen.getByText(/could not complete the encryption example/)).toBeVisible();
    expect(container.textContent).not.toContain('SECRET_EXCEPTION_MATERIAL');
    await user.click(screen.getByRole('button', { name: 'Encrypt & decrypt' }));
    expect(screen.getByText(example.combinedCiphertextHex)).toBeVisible();
  });

  it('validates UTF-8 length and blank input before crypto or sending', async () => {
    const user = userEvent.setup(); const parameters = props();
    render(<SimpleEncryptionDemo {...parameters} />);
    const input = screen.getByRole('textbox', { name: 'Your message' });
    fireEvent.change(input, { target: { value: '🙂'.repeat(130) } });
    await user.click(screen.getByRole('button', { name: 'Encrypt & decrypt' }));
    expect(screen.getByText(/up to 512 UTF-8 bytes/)).toBeVisible(); expect(input).toHaveFocus();
    expect(cryptoDemo).not.toHaveBeenCalled(); expect(parameters.onSend).not.toHaveBeenCalled();
  });

  it('sends through the real chat action and shows an ACK without claiming recipient decryption', async () => {
    const user = userEvent.setup(); const parameters = props({ messages: [message()], events: [
      event('message_encrypted'), event('ciphertext_sent'), event('relay_accepted', {
        serverMessageId: 'server-1', serverSentAt: '2026-11-13T10:00:00Z', duplicate: false,
      }),
    ] });
    render(<SimpleEncryptionDemo {...parameters} />);
    await user.click(screen.getByRole('button', { name: 'Live chat' }));
    await user.click(screen.getByRole('button', { name: 'Send & watch' }));
    expect(parameters.onSend).toHaveBeenCalledWith('hi'); expect(cryptoDemo).not.toHaveBeenCalled();
    expect(screen.getByText('D'.repeat(24))).toBeVisible();
    expect(screen.getByText(/Backend accepted the encrypted message/)).toBeVisible();
    expect(screen.getByText(/No successful local decryption observed/)).toBeVisible();
    expect(screen.getByText(/do not prove your partner decrypted it/)).toBeVisible();
    await user.click(screen.getByText('Inspect the actual encrypted envelope'));
    expect(screen.getByText(/"message_id": "server-1"/)).toBeVisible();
    expect(screen.getByText(/Key identifiers identify the keys/)).toBeVisible();
  });

  it('shows a decrypted result only for a matching live local decryption observation', async () => {
    const user = userEvent.setup();
    const parameters = props({ messages: [message({ senderId: 'bob' })], events: [
      event('message_decrypted', { messageId: 'different-message', direction: 'incoming' }),
    ] });
    const { rerender } = render(<SimpleEncryptionDemo {...parameters} />);
    await user.click(screen.getByRole('button', { name: 'Live chat' }));
    expect(within(screen.getByLabelText('Actual message result')).getAllByText('hi')).toHaveLength(1);
    rerender(<SimpleEncryptionDemo {...parameters} events={[event('message_decrypted', { direction: 'incoming' })]} />);
    expect(within(screen.getByLabelText('Actual message result')).getAllByText('hi')).toHaveLength(2);
    expect(screen.getByText('Integrity checked by this browser')).toBeVisible();
  });

  it('excludes media manifests, malformed attachment prefixes and controls before rendering plaintext', async () => {
    const user = userEvent.setup(); const parameters = props({ messages: [
      message({ text: 'QKD-ATTACHMENT-V1:{"key":"DONT_RENDER_SECRET"}' }),
      message({ text: 'QKD-MEDIA-CONTROL-V1:DONT_RENDER_SECRET', clientMessageId: 'control' }),
    ] });
    const { container } = render(<SimpleEncryptionDemo {...parameters} />);
    await user.click(screen.getByRole('button', { name: 'Live chat' }));
    expect(container.textContent).not.toContain('DONT_RENDER_SECRET');
  });

  it('labels an own echo locally and resets old ACK/decryption evidence for a new encryption attempt', async () => {
    const user = userEvent.setup();
    const initial = [event('message_encrypted'), event('ciphertext_sent'), event('relay_accepted'), event('message_decrypted')];
    const parameters = props({ messages: [message()], events: initial });
    const { rerender } = render(<SimpleEncryptionDemo {...parameters} />);
    await user.click(screen.getByRole('button', { name: 'Live chat' }));
    expect(screen.getByText('Your returned envelope opened locally')).toBeVisible();
    expect(screen.getByText(/do not prove your partner decrypted it/)).toBeVisible();
    rerender(<SimpleEncryptionDemo {...parameters} events={[...initial, event('message_encrypted', { id: 'fresh-encryption' }), event('ciphertext_sent', { id: 'fresh-send' })]} />);
    expect(screen.getByText('Waiting for the backend acknowledgement.')).toBeVisible();
    expect(screen.getByText('No successful local decryption observed')).toBeVisible();
    expect(within(screen.getByLabelText('Actual message result')).getAllByText('hi')).toHaveLength(1);
  });

  it('does not treat stored history as a live ACK or show unavailable message contents', async () => {
    const user = userEvent.setup(); const parameters = props({ messages: [message({ security: 'unavailable', text: 'DO_NOT_RENDER_UNAVAILABLE' })],
      events: [event('relay_accepted', { source: 'history' }), event('message_decrypted', { source: 'history' })] });
    const { container } = render(<SimpleEncryptionDemo {...parameters} />);
    await user.click(screen.getByRole('button', { name: 'Live chat' }));
    expect(screen.getByText(/Recorded message · no live backend response retained/)).toBeVisible();
    expect(container.textContent).not.toContain('DO_NOT_RENDER_UNAVAILABLE');
    expect(screen.queryByText(/Backend accepted/)).not.toBeInTheDocument();
  });

  it('keeps live sending gated while allowing the separate learning example offline', async () => {
    const user = userEvent.setup(); const parameters = props();
    render(<SimpleEncryptionDemo {...parameters} connection={{ ...parameters.connection, state: 'offline' }}
      encryption={{ ...parameters.encryption, canSend: false, state: 'key_changed' }} />);
    await user.click(screen.getByRole('button', { name: 'Live chat' }));
    expect(screen.getByRole('button', { name: 'Send & watch' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Learn with keys' }));
    expect(screen.getByRole('button', { name: 'Encrypt & decrypt' })).toBeEnabled();
  });
});
