import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EncryptionStory } from './EncryptionStory';
import type { Bb84Result, Bb84RunState } from './bb84';
import type { ConnectionInfo, EncryptionInfo, EncryptionState } from './types';

const connection: ConnectionInfo = { state: 'connected', attempt: 0, nextRetrySeconds: null, error: null };
const result: Bb84Result = {
  sessionId: 'demo', startedBy: 'alice', createdAt: '2026-11-12T00:00:00Z', simulationOnly: true, chatEncryptionActive: false,
  config: { qubitCount: 1024, noiseProbability: 0, interceptProbability: 0, sampleRatio: .25, qberThreshold: .11, seed: null },
  metrics: { transmitted: 1024, intercepted: 0, sifted: 500, sample: 125, mismatches: 0, qber: 0, retained: 375 },
  decision: { status: 'accepted', reason: 'qber_within_threshold' },
  postProcessing: {
    version: 'phase3-post-processing-v1', status: 'completed', reason: 'completed', inputBits: 375,
    reconciliation: { algorithm: 'cascade-inspired-parity-v1', passes: 6, correctedErrors: 0, remainingErrors: 0, leakedBits: 40, verified: true },
    privacyAmplification: { algorithm: 'toeplitz-universal-hash-v1', entropyModel: 'illustrative-asymptotic-bb84-binary-entropy-v1', securityMarginBits: 32, estimatedSecretBits: 200, outputBits: 128 },
    confirmation: { algorithm: 'hmac-sha256-truncated-v1', tagBits: 128, passed: true },
    derivation: { algorithm: 'hkdf-sha256-v1', outputBits: 256, contextBound: true, materialRetained: false },
    keyMaterialExposed: false, keyUsedForChat: false, reproducibleTeachingRun: false,
  },
  trace: [],
};

function encryption(state: EncryptionState = 'encrypted_unverified'): EncryptionInfo {
  return { state, canSend: state.startsWith('encrypted_'), verificationCode: '1234 5678 9012', verifiedAt: null,
    localKeyId: 'local-key-identifier', peerKeyId: 'peer-key-identifier', sessionKeyId: 'session-key-identifier',
    keyStorage: 'device', peerName: 'Bob', error: null };
}

function props(state: EncryptionState = 'encrypted_unverified') {
  return { encryption: encryption(state), connection, bb84State: 'idle' as Bb84RunState, bb84Result: null,
    onOpenLab: vi.fn(), onOpenSecurity: vi.fn() };
}

describe('chat protection explanation', () => {
  it('starts collapsed and opens the conceptual path without exposing identifiers or the safety code', async () => {
    const user = userEvent.setup();
    const { container } = render(<EncryptionStory {...props()} />);
    const disclosure = container.querySelector('details');
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(screen.getByText('How protection works'));
    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByRole('list', { name: 'Conceptual encrypted message path' })).toBeVisible();
    expect(screen.getByText(/not a live packet tracker/)).toBeVisible();
    expect(container.textContent).not.toContain('1234 5678 9012');
    expect(container.textContent).not.toContain('key-identifier');
    await user.click(screen.getByText('How protection works'));
    expect(disclosure).not.toHaveAttribute('open');
  });

  it.each<[EncryptionState, string]>([
    ['idle', 'Encryption pending'], ['setting_up', 'Setting up encryption'],
    ['waiting_for_peer', 'Waiting for partner key'], ['encrypted_unverified', 'Encrypted · device unverified'],
    ['encrypted_verified', 'Encrypted · verified on this browser'],
    ['key_changed', 'Sending paused · device key changed'], ['failed', 'Encryption failed · sending paused'],
  ])('reports %s independently from a completed BB84 result', (state, label) => {
    const { container } = render(<EncryptionStory {...props(state)} bb84State="complete" bb84Result={result} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(container).toHaveTextContent('Its output is not used for chat encryption');
    if (state !== 'encrypted_verified') expect(container).not.toHaveTextContent('The current safety code was verified');
  });

  it('retains the local verified state while reporting offline delivery separately', async () => {
    const user = userEvent.setup();
    render(<EncryptionStory {...props('encrypted_verified')} connection={{ ...connection, state: 'offline' }} />);
    await user.click(screen.getByText('How protection works'));
    expect(screen.getByText('Encrypted · verified on this browser')).toBeVisible();
    expect(screen.getByText(/Connection: offline/)).toHaveTextContent('Delivery waits for the connection to return');
  });

  it.each<[Bb84RunState, Bb84Result | null, string]>([
    ['idle', null, 'Not started'],
    ['running', result, 'Experiment running'],
    ['error', result, 'Result unavailable'],
    ['complete', result, 'Simulated key preparation completed'],
    ['complete', { ...result, decision: { status: 'aborted', reason: 'qber_above_threshold' } }, 'Experiment stopped'],
    ['complete', { ...result, postProcessing: { ...result.postProcessing, status: 'failed', reason: 'insufficient_entropy' } }, 'Sample passed · final key preparation failed'],
  ])('describes %s without presenting a sample as a usable key', async (state, received, label) => {
    const user = userEvent.setup();
    render(<EncryptionStory {...props()} bb84State={state} bb84Result={received} />);
    await user.click(screen.getByText('How protection works'));
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(/not physical quantum key distribution/)).toBeVisible();
  });

  it('opens the existing security and lab workflows', async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<EncryptionStory {...handlers} />);
    await user.click(screen.getByText('How protection works'));
    await user.click(screen.getByRole('button', { name: 'Security details' }));
    await user.click(screen.getByRole('button', { name: 'Open experiment' }));
    expect(handlers.onOpenSecurity).toHaveBeenCalledOnce();
    expect(handlers.onOpenLab).toHaveBeenCalledOnce();
  });
});
