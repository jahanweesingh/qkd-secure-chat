import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LiveSecurityView, type LiveSecurityViewProps } from './LiveSecurityView';
import type { SecurityTraceEvent, SecurityTraceKind } from './securityTrace';
import type { EncryptionInfo, EncryptionState } from './types';

const encrypted: EncryptionInfo = {
  state: 'encrypted_unverified', canSend: true, verificationCode: '1234 5678 9012', verifiedAt: null,
  peerName: 'Bob', localKeyId: 'do-not-render-local-id', peerKeyId: 'do-not-render-peer-id',
  sessionKeyId: 'do-not-render-session-id', keyStorage: 'device', error: null,
};

function event(kind: SecurityTraceKind, overrides: Partial<SecurityTraceEvent> = {}): SecurityTraceEvent {
  return { id: `${kind}-${overrides.id || '1'}`, kind, timestamp: 1_700_000_000_000,
    source: 'live', direction: 'outgoing', messageId: 'message-one', ...overrides };
}

function props(events: SecurityTraceEvent[] = []): LiveSecurityViewProps {
  return { events, connection: { state: 'connected', attempt: 0, nextRetrySeconds: null, error: null },
    encryption: encrypted, onClear: vi.fn(), onOpenLab: vi.fn(), onOpenSecurity: vi.fn() };
}

describe('live encryption presentation', () => {
  it('shows a useful empty state and keeps connection, encryption, and verification separate', () => {
    const { container } = render(<LiveSecurityView {...props()} />);
    expect(screen.getByRole('heading', { name: 'Follow the encrypted exchange' })).toBeVisible();
    expect(screen.getByText('Live', { selector: 'dd' })).toBeVisible();
    expect(screen.getByText('Active', { selector: 'dd' })).toBeVisible();
    expect(screen.getByText('Not verified here')).toBeVisible();
    expect(screen.getByText(/Send a chat message from this Mac/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clear observations' })).toBeDisabled();
    expect(container.textContent).not.toContain('1234 5678 9012');
    expect(container.textContent).not.toContain('do-not-render');
  });

  it('uses an actual outgoing encryption and ACK without implying the partner decrypted it', () => {
    render(<LiveSecurityView {...props([
      event('message_encrypted', { ciphertextPreview: 'Actual_ciphertext-prefix_123', bytes: 48 }),
      event('ciphertext_sent'), event('relay_accepted'),
      event('ciphertext_received'), event('message_decrypted'),
    ])} />);
    const path = screen.getByRole('list', { name: 'Outgoing message evidence' });
    expect(within(path).getByText('Encrypted locally')).toBeVisible();
    expect(within(path).getByText('Accepted by server')).toBeVisible();
    expect(within(path).getByText('Not observed here')).toBeVisible();
    expect(within(path).queryByText('Authenticated locally')).not.toBeInTheDocument();
    expect(screen.getByText(/It does not confirm that the partner decrypted/)).toBeVisible();
    expect(screen.getByText('Actual_ciphertext-prefix_123…')).toBeVisible();
    expect(screen.getByText(/ciphertext and tag: 48 bytes/)).toBeVisible();
    expect(screen.getByText('Your relay echo authenticated locally', { selector: 'strong' })).toBeVisible();
  });

  it('shows incoming decryption only after a successful local authentication observation', () => {
    const received = event('ciphertext_received', { direction: 'incoming' });
    const { rerender } = render(<LiveSecurityView {...props([received])} />);
    let path = screen.getByRole('list', { name: 'Incoming message evidence' });
    expect(within(path).getByText('Envelope received')).toBeVisible();
    expect(within(path).getByText('Not opened yet')).toBeVisible();
    expect(within(path).queryByText('Authenticated locally')).not.toBeInTheDocument();
    rerender(<LiveSecurityView {...props([received, event('message_decrypted', { direction: 'incoming' })])} />);
    path = screen.getByRole('list', { name: 'Incoming message evidence' });
    expect(within(path).getByText('Checked and decrypted')).toBeVisible();
    expect(within(path).getByText('Authenticated locally')).toBeVisible();
  });

  it('never combines evidence from different messages to complete the latest path', () => {
    render(<LiveSecurityView {...props([
      event('message_encrypted', { messageId: 'old', id: 'old-encrypted' }),
      event('ciphertext_sent', { messageId: 'old', id: 'old-sent' }),
      event('relay_accepted', { messageId: 'old', id: 'old-accepted' }),
      event('message_encrypted', { messageId: 'new', id: 'new-encrypted' }),
      event('ciphertext_sent', { messageId: 'new', id: 'new-sent' }),
    ])} />);
    const path = screen.getByRole('list', { name: 'Outgoing message evidence' });
    expect(within(path).getByText('Awaiting acknowledgement')).toBeVisible();
    expect(within(path).queryByText('Accepted by server')).not.toBeInTheDocument();
  });

  it('shows a retry as pending and then accepted while retaining the earlier failure in the timeline', () => {
    const initial = [event('message_encrypted'), event('ciphertext_sent'), event('message_failed')];
    const { rerender } = render(<LiveSecurityView {...props(initial)} />);
    const path = () => within(screen.getByRole('list', { name: 'Outgoing message evidence' }));
    expect(path().getByText('Send failed')).toBeVisible();
    expect(screen.getByText(/Message send failed\. No successful completion is inferred/)).toBeVisible();

    const retry = [...initial, event('ciphertext_sent', { id: 'retry-send' })];
    rerender(<LiveSecurityView {...props(retry)} />);
    expect(path().getByText('Awaiting acknowledgement')).toBeVisible();
    expect(path().queryByText('Send failed')).not.toBeInTheDocument();
    expect(path().queryByText('Accepted by server')).not.toBeInTheDocument();
    expect(screen.queryByText(/Message send failed\. No successful completion is inferred/)).not.toBeInTheDocument();

    rerender(<LiveSecurityView {...props([...retry, event('relay_accepted', { id: 'retry-ack' })])} />);
    expect(path().getByText('Accepted by server')).toBeVisible();
    expect(path().queryByText('Send failed')).not.toBeInTheDocument();
    expect(path().getByText('Not observed here')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Local observation timeline' }))
      .getByText('Message send failed')).toBeVisible();
    expect(screen.queryByText(/Message send failed\. No successful completion is inferred/)).not.toBeInTheDocument();
  });

  it('does not reuse an earlier acknowledgement or successful relay echo for a later failed attempt', () => {
    const accepted = [event('message_encrypted'), event('ciphertext_sent'), event('relay_accepted')];
    const retry = [...accepted, event('ciphertext_sent', { id: 'second-send' })];
    const { rerender } = render(<LiveSecurityView {...props(retry)} />);
    const path = () => within(screen.getByRole('list', { name: 'Outgoing message evidence' }));
    expect(path().getByText('Awaiting acknowledgement')).toBeVisible();
    expect(path().queryByText('Accepted by server')).not.toBeInTheDocument();
    rerender(<LiveSecurityView {...props([
      ...retry, event('message_failed'), event('ciphertext_received'), event('message_decrypted'),
    ])} />);
    expect(path().getByText('Send failed')).toBeVisible();
    expect(path().queryByText('Accepted by server')).not.toBeInTheDocument();
    expect(screen.getByText(/Message send failed\. No successful completion is inferred/)).toBeVisible();
  });

  it('labels clipped earlier observations as unavailable instead of inventing a pending stage', () => {
    const { rerender } = render(<LiveSecurityView {...props([event('relay_accepted')])} />);
    let path = screen.getByRole('list', { name: 'Outgoing message evidence' });
    expect(within(path).getAllByText('Not retained in this view')).toHaveLength(2);
    expect(within(path).queryByText('Waiting for encryption')).not.toBeInTheDocument();
    expect(within(path).getByText('Accepted by server')).toBeVisible();
    rerender(<LiveSecurityView {...props([event('message_decrypted', { direction: 'incoming' })])} />);
    path = screen.getByRole('list', { name: 'Incoming message evidence' });
    expect(within(path).getByText('Receipt event not retained')).toBeVisible();
    expect(within(path).getByText('Authenticated locally')).toBeVisible();
  });

  it('can show sealed local data before sending without claiming it travelled over the network', () => {
    render(<LiveSecurityView {...props([event('message_encrypted', { ciphertextPreview: 'actual_prefix' })])} />);
    expect(screen.getByText('Encrypted payload observed here')).toBeVisible();
    const path = screen.getByRole('list', { name: 'Outgoing message evidence' });
    expect(within(path).getByText('Waiting for an envelope')).toBeVisible();
    expect(within(path).queryByText('Accepted by server')).not.toBeInTheDocument();
  });

  it('keeps history replay out of the live path and observation list', () => {
    render(<LiveSecurityView {...props([
      event('ciphertext_received', { direction: 'incoming', source: 'history' }),
      event('message_decrypted', { direction: 'incoming', source: 'history' }),
    ])} />);
    expect(screen.getByText('Waiting for an observed operation.')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Local observation timeline' })).not.toBeInTheDocument();
    expect(screen.getByText('No live envelope observed in this direction yet.')).toBeVisible();
  });

  it('withholds completion when an incoming message fails its integrity check', () => {
    render(<LiveSecurityView {...props([
      event('ciphertext_received', { direction: 'incoming' }),
      event('integrity_failed', { direction: 'incoming' }),
    ])} encryption={{ ...encrypted, state: 'failed', canSend: false }} />);
    const path = screen.getByRole('list', { name: 'Incoming message evidence' });
    expect(within(path).getByText('Authentication failed')).toBeVisible();
    expect(within(path).getByText('Content withheld')).toBeVisible();
    expect(within(path).queryByText('Authenticated locally')).not.toBeInTheDocument();
    expect(screen.getByText(/Sending is paused because encryption failed/)).toBeVisible();
  });

  it.each<[EncryptionState, string]>([
    ['setting_up', 'Setting up'], ['waiting_for_peer', 'Waiting for partner'],
    ['key_changed', 'Paused · key changed'], ['failed', 'Failed'],
  ])('reports %s without changing it into a successful encryption state', (state, label) => {
    render(<LiveSecurityView {...props()} encryption={{ ...encrypted, state, canSend: false }} />);
    expect(screen.getByText(label, { selector: 'dd' })).toBeVisible();
    expect(screen.queryByText('Verified on this browser')).not.toBeInTheDocument();
  });

  it('keeps a verified key state separate from an offline connection', () => {
    const parameters = props();
    render(<LiveSecurityView {...parameters} connection={{ ...parameters.connection, state: 'offline' }}
      encryption={{ ...encrypted, state: 'encrypted_verified', verifiedAt: '2026-11-13T08:00:00Z' }} />);
    expect(screen.getByText('offline', { selector: 'dd' })).toBeVisible();
    expect(screen.getByText('Verified on this browser')).toBeVisible();
    expect(screen.getByText(/New message delivery waits for the connection/)).toBeVisible();
  });

  it('supports keyboard direction switching and calls existing security and lab actions', async () => {
    const user = userEvent.setup();
    const parameters = props([event('message_encrypted')]);
    render(<LiveSecurityView {...parameters} />);
    const receiving = screen.getByRole('button', { name: 'Receiving' });
    receiving.focus();
    await user.keyboard('{Enter}');
    expect(receiving).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Ask your partner to send a chat message/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear observations' }));
    await user.click(screen.getByRole('button', { name: 'Security details' }));
    await user.click(screen.getByRole('button', { name: 'Open BB84 lab' }));
    expect(parameters.onClear).toHaveBeenCalledOnce();
    expect(parameters.onOpenSecurity).toHaveBeenCalledOnce();
    expect(parameters.onOpenLab).toHaveBeenCalledOnce();
  });

  it('displays only the allowed ciphertext prefix, never extra trace fields or unsafe payload text', () => {
    const invalid = { ...event('message_encrypted'), ciphertextPreview: '<unsafe plaintext>',
      privateKey: 'DO_NOT_SHOW_PRIVATE_KEY', plaintext: 'DO_NOT_SHOW_MESSAGE', manifest: 'DO_NOT_SHOW_MANIFEST' };
    const { container } = render(<LiveSecurityView {...props([invalid])} />);
    expect(screen.queryByLabelText('Observed encrypted payload')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('DO_NOT_SHOW');
    expect(container.textContent).not.toContain('<unsafe plaintext>');
  });

  it('keeps the initial observation list compact and makes its retained events available', async () => {
    const user = userEvent.setup();
    render(<LiveSecurityView {...props(Array.from({ length: 12 }, (_, index) => event('public_key_sent', {
      id: `observation-${index}`, messageId: undefined, direction: undefined,
    })))} />);
    expect(within(screen.getByRole('list', { name: 'Local observation timeline' })).getAllByRole('listitem')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Show all 12 observations' }));
    expect(within(screen.getByRole('list', { name: 'Local observation timeline' })).getAllByRole('listitem')).toHaveLength(12);
    await user.click(screen.getByRole('button', { name: 'Show recent observations' }));
    expect(within(screen.getByRole('list', { name: 'Local observation timeline' })).getAllByRole('listitem')).toHaveLength(8);
  });

  it('makes packet capture and the separate BB84 experiment boundaries explicit', async () => {
    const user = userEvent.setup();
    render(<LiveSecurityView {...props()} />);
    expect(screen.getByText(/This screen observes the app. It is not a network packet capture/)).toBeVisible();
    expect(screen.getByText(/BB84 output is not connected to these chat keys/)).toBeVisible();
    await user.click(screen.getByText('See technical details'));
    expect(screen.getByText(/History replay is excluded from this live view/)).toBeVisible();
    expect(screen.getByText(/these byte counts are not file-transfer progress/)).toBeVisible();
  });
});
