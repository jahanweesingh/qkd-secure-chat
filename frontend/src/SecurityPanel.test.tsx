import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_ENDPOINT_BB84_PROGRESS } from './bb84ChatSession';
import { SecurityPanel } from './App';
import type { EncryptionInfo } from './types';

const baseEncryption: EncryptionInfo = {
  state: 'encrypted_unverified', canSend: true, activeKeyMode: 'ecdh',
  verificationCode: null, verifiedAt: null, peerName: 'Bob',
  localKeyId: 'local-key-id', peerKeyId: 'peer-key-id', sessionKeyId: 'pair-key-id',
  keyStorage: 'device', error: null,
};

function panelProps(encryption: EncryptionInfo, status: typeof EMPTY_ENDPOINT_BB84_PROGRESS['status'] = 'idle') {
  return {
    open: true,
    encryption,
    endpointBb84: { ...EMPTY_ENDPOINT_BB84_PROGRESS, status },
    onClose: vi.fn(), onVerify: vi.fn(), onClearVerification: vi.fn(),
    onAcceptChangedKey: vi.fn(), onRetry: vi.fn(),
  };
}

async function openTechnicalDetails() {
  await userEvent.setup().click(screen.getByText('Technical details'));
  return screen.getByRole('region', { name: 'Endpoint BB84 and chat key status' });
}

describe('SecurityPanel active key mode details', () => {
  it('keeps the ECDH-only summary compact and puts derivation in collapsed technical details', async () => {
    render(<SecurityPanel {...panelProps(baseEncryption)} />);
    const summary = screen.getByRole('status', { name: 'Current chat security' });
    expect(summary).toHaveClass('security-overview');
    expect(summary.querySelectorAll('.security-overview__indicators > span')).toHaveLength(3);
    expect(screen.queryByRole('status', { name: 'Encrypted · Unverified' })).not.toBeInTheDocument();
    expect(summary).toHaveTextContent('ECDH-only');
    expect(summary).toHaveTextContent(/BB84 contribution\s+Not started/);
    expect(summary).toHaveTextContent(/Key confirmation\s+Not reached/);
    expect(summary).toHaveTextContent('AES-256-GCM');
    expect(screen.getByText(/ECDH shared secret → HKDF-SHA-256/)).not.toBeVisible();
    const details = await openTechnicalDetails();
    expect(details).toHaveTextContent('BB84 sessionNot started');
    expect(screen.getByText(/ECDH shared secret → HKDF-SHA-256 → separate directional AES-256-GCM keys/)).toBeVisible();
  });

  it('shows hybrid derivation and confirmed active epoch only from active runtime mode', async () => {
    const hybrid = { ...baseEncryption, activeKeyMode: 'bb84_hybrid' as const };
    render(<SecurityPanel {...panelProps(hybrid, 'complete')} />);
    const summary = screen.getByRole('status', { name: 'Current chat security' });
    expect(summary).toHaveTextContent('BB84 + ECDH Hybrid');
    expect(summary).toHaveTextContent(/BB84 contribution\s+Confirmed/);
    expect(summary).toHaveTextContent(/Key confirmation\s+Confirmed/);
    expect(summary).toHaveTextContent('AES-256-GCM');
    const details = await openTechnicalDetails();
    expect(details).toHaveTextContent(/Chat encryptionBB84-ECDH hybrid active/);
    expect(details).toHaveTextContent(/BB84 sessionCompleted/);
    expect(details).toHaveTextContent(/Active hybrid epochActive/);
    expect(screen.getByText(/ECDH shared secret \+ confirmed BB84 contribution → HKDF-SHA-256 → separate directional AES-256-GCM keys/)).toBeVisible();
    expect(details.textContent).not.toMatch(/(?:key bytes|private key|secret bytes)/i);
  });

  it('switches the panel back to ECDH fallback without claiming the hybrid epoch is active', async () => {
    const completedButFallback = panelProps(baseEncryption, 'complete');
    const { rerender } = render(<SecurityPanel {...completedButFallback} />);
    let details = await openTechnicalDetails();
    expect(details).toHaveTextContent(/Chat encryptionECDH-only/);
    expect(details).toHaveTextContent(/BB84 sessionCompleted/);
    expect(details).toHaveTextContent(/BB84 key contributionConfirmed/);
    expect(details).toHaveTextContent(/Contribution in chat encryptionInactive · ECDH fallback active/);
    expect(details).toHaveTextContent(/Mutual key confirmationConfirmed/);
    expect(details).toHaveTextContent(/Active hybrid epochNot active/);
    expect(screen.queryByText(/ECDH fallback is selected/)).not.toBeInTheDocument();

    rerender(<SecurityPanel {...panelProps({ ...baseEncryption, activeKeyMode: 'bb84_hybrid' }, 'complete')} />);
    details = screen.getByRole('region', { name: 'Endpoint BB84 and chat key status' });
    expect(details).toHaveTextContent(/Chat encryptionBB84-ECDH hybrid active/);
    rerender(<SecurityPanel {...panelProps(baseEncryption, 'complete')} />);
    details = screen.getByRole('region', { name: 'Endpoint BB84 and chat key status' });
    expect(details).toHaveTextContent(/Chat encryptionECDH-only/);
    expect(details).toHaveTextContent(/Active hybrid epochNot active/);
  });
});
