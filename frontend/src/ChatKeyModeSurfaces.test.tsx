import { createRef, useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProtocolLab, SecurityPanel } from './App';
import { EMPTY_ENDPOINT_BB84_PROGRESS } from './bb84ChatSession';
import type { EndpointBb84Progress } from './bb84ChatSession';
import type { EncryptionInfo } from './types';

const initialEncryption: EncryptionInfo = {
  state: 'encrypted_unverified', canSend: true, activeKeyMode: 'ecdh',
  verificationCode: null, verifiedAt: null, peerName: 'Bob', localKeyId: 'local-id',
  peerKeyId: 'peer-id', sessionKeyId: 'pair-id', keyStorage: 'device', error: null,
};

function BothSecuritySurfaces({ initialMode, protocolStatus }: {
  initialMode: NonNullable<EncryptionInfo['activeKeyMode']>;
  protocolStatus: EndpointBb84Progress['status'];
}) {
  const [encryption, setEncryption] = useState({ ...initialEncryption, activeKeyMode: initialMode });
  const endpointBb84: EndpointBb84Progress = {
    ...EMPTY_ENDPOINT_BB84_PROGRESS,
    status: protocolStatus,
    role: protocolStatus === 'idle' ? null : 'alice',
  };
  return <>
    <SecurityPanel open encryption={encryption} endpointBb84={endpointBb84} onClose={vi.fn()} onVerify={vi.fn()}
      onClearVerification={vi.fn()} onAcceptChangedKey={vi.fn()} onRetry={vi.fn()} />
    <ProtocolLab open encryption={encryption} connection={{ state: 'connected', attempt: 0, nextRetrySeconds: null, error: null }}
      participants={[]} currentClientId="alice" result={null} state="idle" error={null} returnFocusRef={createRef<HTMLButtonElement>()}
      onRun={vi.fn(() => true)} endpointBb84={endpointBb84} onStartEndpointBb84={vi.fn(() => true)}
      onUseEcdhFallback={() => setEncryption(current => ({ ...current, activeKeyMode: 'ecdh' }))} onClose={vi.fn()} />
  </>;
}

function securityRuntimeSummary() { return within(screen.getByRole('dialog', { name: 'Security details' })).getByRole('region', { name: 'Endpoint BB84 and chat key status' }); }
function labDialog() { return within(screen.getByRole('dialog', { name: 'BB84 Security Lab' })); }
function labMode() { return labDialog().getByText(/(?:ECDH-only chat active|Hybrid key active)/); }
async function openLabRuntime() {
  await userEvent.setup().click(labDialog().getByText('Detailed endpoint protocol status'));
  return labDialog().getByRole('region', { name: 'Endpoint BB84 and chat key status' });
}

describe('shared runtime key status in Security Details and BB84 Security Lab', () => {
  it('shows ECDH-only and BB84 not started in both surfaces', async () => {
    const user = userEvent.setup();
    render(<BothSecuritySurfaces initialMode="ecdh" protocolStatus="idle" />);
    await user.click(within(screen.getByRole('dialog', { name: 'Security details' })).getByText('Technical details'));
    expect(securityRuntimeSummary()).toHaveTextContent('BB84 sessionNot started');
    expect(securityRuntimeSummary()).toHaveTextContent('Chat encryptionECDH-only');
    expect(labMode()).toHaveTextContent('ECDH-only chat active');
    expect(labDialog().getByRole('list', { name: 'Endpoint BB84 establishment steps' })).toBeVisible();
    expect(labDialog().getAllByRole('progressbar')).toHaveLength(1);
    expect(labDialog().getByLabelText('BB84 sample error rate')).toHaveTextContent('Waiting for sample');
    expect(labDialog().queryByRole('status', { name: 'Current chat security' })).not.toBeInTheDocument();
    expect(screen.getByText(/ECDH shared secret → HKDF-SHA-256 → separate directional AES-256-GCM keys/)).toBeVisible();
    expect(labDialog().getByText('Room-hosted teaching simulation · advanced')).toBeVisible();
    expect(labDialog().getByText('Bits to prepare')).not.toBeVisible();
  });

  it('shows in-progress reconciliation without treating it as hybrid activation', async () => {
    const user = userEvent.setup();
    render(<BothSecuritySurfaces initialMode="ecdh" protocolStatus="reconciling" />);
    await user.click(within(screen.getByRole('dialog', { name: 'Security details' })).getByText('Technical details'));
    expect(securityRuntimeSummary()).toHaveTextContent('BB84 sessionIn progress');
    expect(securityRuntimeSummary()).toHaveTextContent('Basis reconciliationIn progress');
    expect(labMode()).toHaveTextContent('ECDH-only chat active');
    expect(screen.getByText('Establishing the hybrid chat key')).toBeVisible();
    const runtime = await openLabRuntime();
    expect(runtime).toHaveTextContent('Basis reconciliationIn progress');
  });

  it('shows a failed endpoint run without a contribution or hybrid epoch', async () => {
    const user = userEvent.setup();
    render(<BothSecuritySurfaces initialMode="ecdh" protocolStatus="failed" />);
    await user.click(within(screen.getByRole('dialog', { name: 'Security details' })).getByText('Technical details'));
    expect(securityRuntimeSummary()).toHaveTextContent('BB84 sessionFailed');
    expect(securityRuntimeSummary()).toHaveTextContent('Basis reconciliationIncomplete');
    expect(securityRuntimeSummary()).toHaveTextContent('Privacy amplificationIncomplete');
    expect(labMode()).toHaveTextContent('ECDH-only chat active');
    expect(screen.getByRole('alert')).toHaveTextContent('BB84 exchange failed');
    expect(await openLabRuntime()).toHaveTextContent('BB84 key contributionFailed');
  });

  it('shows confirmed hybrid activation in both surfaces and updates both on ECDH fallback', async () => {
    const user = userEvent.setup();
    render(<BothSecuritySurfaces initialMode="bb84_hybrid" protocolStatus="complete" />);
    await user.click(within(screen.getByRole('dialog', { name: 'Security details' })).getByText('Technical details'));
    expect(securityRuntimeSummary()).toHaveTextContent('BB84 sessionCompleted');
    expect(securityRuntimeSummary()).toHaveTextContent('Active hybrid epochActive');
    expect(labMode()).toHaveTextContent('Hybrid key active');
    expect(labDialog().getByText('Hybrid chat key active')).toBeVisible();
    expect(screen.getByText(/ECDH shared secret \+ confirmed BB84 contribution → HKDF-SHA-256 → separate directional AES-256-GCM keys/)).toBeVisible();
    expect(labDialog().getByText(/not physical quantum key distribution/i)).toBeVisible();
    let runtime = await openLabRuntime();
    expect(runtime).toHaveTextContent('Mutual key confirmationConfirmed');

    await user.click(screen.getByRole('button', { name: 'Switch chat back to ECDH' }));
    expect(securityRuntimeSummary()).toHaveTextContent('Chat encryptionECDH-only');
    expect(securityRuntimeSummary()).toHaveTextContent('Active hybrid epochNot active');
    expect(labMode()).toHaveTextContent('ECDH-only chat active');
    runtime = labDialog().getByRole('region', { name: 'Endpoint BB84 and chat key status' });
    expect(runtime).toHaveTextContent('Contribution in chat encryptionInactive · ECDH fallback active');
    expect(runtime).toHaveTextContent('Mutual key confirmationConfirmed');
  });
});
