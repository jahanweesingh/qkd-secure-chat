import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Bb84Result } from './bb84';
import { EMPTY_ENDPOINT_BB84_PROGRESS, type EndpointBb84Progress } from './bb84ChatSession';
import type { EncryptionInfo, EncryptionState } from './types';
import { ChatKeyModeSummary, ChatProtectionSummary, SecurityLabWalkthrough } from './SecurityLabWalkthrough';

const result: Bb84Result = {
  sessionId: 'test-run', startedBy: 'alice', createdAt: '2026-11-12T12:00:00Z',
  simulationOnly: true, chatEncryptionActive: false,
  config: { qubitCount: 1024, noiseProbability: 0, interceptProbability: 0.25, sampleRatio: 0.25, qberThreshold: 0.11, seed: null },
  metrics: { transmitted: 1024, intercepted: 248, sifted: 500, sample: 125, mismatches: 5, qber: 0.04, retained: 375 },
  decision: { status: 'accepted', reason: 'qber_within_threshold' },
  postProcessing: {
    version: 'phase3-post-processing-v1', status: 'completed', reason: 'completed', inputBits: 375,
    reconciliation: { algorithm: 'cascade-inspired-parity-v1', passes: 4, correctedErrors: 12, remainingErrors: 0, leakedBits: 60, verified: true },
    privacyAmplification: { algorithm: 'toeplitz-universal-hash-v1', entropyModel: 'illustrative-asymptotic-bb84-binary-entropy-v1', securityMarginBits: 32, estimatedSecretBits: 192, outputBits: 128 },
    confirmation: { algorithm: 'hmac-sha256-truncated-v1', tagBits: 128, passed: true },
    derivation: { algorithm: 'hkdf-sha256-v1', outputBits: 256, contextBound: true, materialRetained: false },
    keyMaterialExposed: false, keyUsedForChat: false, reproducibleTeachingRun: false,
  },
  trace: [
    { index: 3, aliceBasis: 'Z', bobBasis: 'Z', basisMatch: true, intercepted: false, sampled: true, sampleComparison: 'match' },
    { index: 9, aliceBasis: 'X', bobBasis: 'Z', basisMatch: false, intercepted: true, sampled: false, sampleComparison: null },
  ],
};

function encryption(state: EncryptionState): EncryptionInfo {
  return { state, canSend: state.startsWith('encrypted_'), activeKeyMode: state.startsWith('encrypted_') ? 'ecdh' : null, verificationCode: null, verifiedAt: null,
    peerName: null, localKeyId: null, peerKeyId: null, sessionKeyId: null, keyStorage: null, error: null };
}

function metric(label: string, value: string) {
  expect(screen.getByText(label, { selector: 'dt' }).nextElementSibling).toHaveTextContent(value);
}

function endpointProgress(status: EndpointBb84Progress['status'] = 'idle'): EndpointBb84Progress {
  return { ...EMPTY_ENDPOINT_BB84_PROGRESS, status };
}

describe('compact chat security status', () => {
  it('shows the active chat mode and keeps detailed derivation out of the compact card', () => {
    render(<ChatProtectionSummary encryption={encryption('encrypted_unverified')} endpointBb84={endpointProgress()} connection={{ state: 'connected', attempt: 0, nextRetrySeconds: null, error: null }} />);
    const summary = screen.getByRole('status', { name: 'Current chat security' });
    expect(summary).toHaveTextContent('ECDH-only');
    expect(summary).toHaveTextContent(/BB84 contribution\s+Not started/);
    expect(summary).toHaveTextContent(/Mutual key confirmation\s+Not reached/);
    expect(summary).toHaveTextContent('AES-256-GCM');
    expect(summary).not.toHaveTextContent('HKDF-SHA-256');
  });

  it('keeps transport state separate from active encryption mode', () => {
    render(<ChatProtectionSummary encryption={encryption('encrypted_verified')} endpointBb84={endpointProgress()} connection={{ state: 'offline', attempt: 0, nextRetrySeconds: null, error: null }} />);
    expect(screen.getByRole('status', { name: 'Current chat security' })).toHaveTextContent('ECDH-only');
    expect(screen.getByText(/Connection offline/)).toBeVisible();
  });

  it('shows hybrid only after activation and marks the contribution inactive after fallback', () => {
    const hybrid = { ...encryption('encrypted_unverified'), activeKeyMode: 'bb84_hybrid' as const };
    const { rerender } = render(<ChatKeyModeSummary encryption={hybrid} endpointBb84={endpointProgress('complete')} />);
    let summary = screen.getByRole('status', { name: 'Current chat security' });
    expect(summary).toHaveTextContent('BB84 + ECDH Hybrid');
    expect(summary).toHaveTextContent(/BB84 contribution\s+Confirmed/);
    expect(summary).toHaveTextContent(/Mutual key confirmation\s+Confirmed/);
    expect(summary).toHaveTextContent('AES-256-GCM');
    expect(summary).not.toHaveTextContent('HKDF-SHA-256');

    rerender(<ChatKeyModeSummary encryption={encryption('encrypted_unverified')} endpointBb84={endpointProgress('complete')} />);
    summary = screen.getByRole('status', { name: 'Current chat security' });
    expect(summary).toHaveTextContent('ECDH-only');
    expect(summary).toHaveTextContent(/BB84 contribution\s+Confirmed · inactive in current chat mode/);
    expect(summary).toHaveTextContent(/Mutual key confirmation\s+Confirmed/);
  });

  it('shows a running or failed contribution without claiming hybrid mode', () => {
    const { rerender } = render(<ChatKeyModeSummary encryption={encryption('encrypted_unverified')} endpointBb84={endpointProgress('reconciling')} />);
    let summary = screen.getByRole('status', { name: 'Current chat security' });
    expect(summary).toHaveTextContent('ECDH-only');
    expect(summary).toHaveTextContent(/BB84 contribution\s+In progress/);
    expect(summary).toHaveTextContent(/Mutual key confirmation\s+Not reached/);
    rerender(<ChatKeyModeSummary encryption={encryption('encrypted_unverified')} endpointBb84={endpointProgress('failed')} />);
    summary = screen.getByRole('status', { name: 'Current chat security' });
    expect(summary).toHaveTextContent(/BB84 contribution\s+Failed/);
    expect(summary).toHaveTextContent('ECDH-only');
  });

  it('shows pending confirmation and a failed closed epoch during and after failed BB84', () => {
    const { rerender } = render(<ChatKeyModeSummary encryption={encryption('encrypted_unverified')} endpointBb84={endpointProgress('key_confirmation')} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Mutual key confirmation\s+Pending/);
    rerender(<ChatKeyModeSummary encryption={encryption('encrypted_unverified')} endpointBb84={endpointProgress('failed')} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Mutual key confirmation\s+Not confirmed/);
  });
});

describe('recorded experiment walkthrough', () => {
  it('lets the reader choose a named notebook step and return to it after reviewing all steps', async () => {
    const user = userEvent.setup();
    render(<SecurityLabWalkthrough result={result} />);
    const index = screen.getByRole('navigation', { name: 'Experiment review steps' });
    const errorCheck = within(index).getByRole('button', { name: /Step 5:/ });
    expect(errorCheck).toHaveTextContent('Check for interference');
    errorCheck.focus();
    await user.keyboard('{Enter}');
    expect(errorCheck).toHaveAttribute('aria-current', 'step');
    expect(within(index).getAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toHaveLength(1);
    expect(screen.getByRole('progressbar', { name: 'Walkthrough review progress' })).toHaveAttribute('value', '5');
    metric('Error percentage', '4.00%');

    await user.click(screen.getByRole('button', { name: 'Show all steps' }));
    expect(screen.queryByRole('navigation', { name: 'Experiment review steps' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(7);
    await user.click(screen.getByRole('button', { name: 'Show one step' }));
    expect(screen.getByRole('button', { name: /Step 5:/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('article', { name: 'Step 5' })).toBeVisible();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('walks through real values, choices and outcomes in order without exposing secret bits', async () => {
    const user = userEvent.setup();
    render(<SecurityLabWalkthrough result={result} />);
    expect(screen.getByText('Experiment completed')).toBeVisible();
    expect(screen.getByText(/recorded results, not live transmission/)).toBeVisible();
    metric('Bits prepared', '1024');
    expect(screen.getByLabelText('Selected positions with secret values hidden')).toHaveTextContent('#4');
    expect(screen.queryByText('Bob measures what he receives', { selector: 'h4' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByRole('heading', { name: 'The information is sent' })).toHaveFocus();
    metric('Actually intercepted', '248 of 1024');
    metric('Configured chance', '25.00%');
    metric('Intercepted share', '24.22%');
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText('Position 4')).toBeVisible();
    expect(screen.getByText('Position 10')).toBeVisible();
    expect(screen.getByText('Same choice')).toBeVisible();
    expect(screen.getByText('Different choices')).toBeVisible();
    expect(screen.getByText('Checked sample: results match')).toBeVisible();
    expect(screen.getByText('Bit result kept private')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    metric('Matching positions', '500'); metric('Discarded positions', '524');
    metric('Candidates after sample removal', '375');
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    metric('Sample bits checked', '125'); metric('Mismatches', '5');
    metric('Error percentage', '4.00%'); metric('Acceptable threshold', '11.00%');
    expect(screen.getByText(/low error rate does not prove Eve is absent/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    metric('Errors corrected', '12'); metric('Remaining errors', '0');
    metric('Information disclosed during correction', '60 bits');
    metric('Estimated secret bits (teaching estimate)', '192 bits');
    metric('Final simulated key length', '128 bits');
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '7');
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '6');
    await user.click(screen.getByRole('button', { name: 'Show all steps' }));
    expect(screen.getAllByRole('article')).toHaveLength(7);
    expect(screen.queryByText(/raw_key|candidate_bits|derived_bytes/)).not.toBeInTheDocument();
  });

  it.each([
    ['insufficient_entropy', /too little estimated secret information/],
    ['reconciliation_failed', /remaining differences could not be corrected/],
    ['confirmation_failed', /final agreement check failed/],
    ['derivation_failed', /final preparation check failed/],
  ] as const)('explains %s and does not show an intermediate value as a final usable key', async (reason, explanation) => {
    const user = userEvent.setup();
    render(<SecurityLabWalkthrough result={{ ...result, postProcessing: { ...result.postProcessing, status: 'failed', reason } }} />);
    expect(screen.getByText('Experiment stopped')).toBeVisible();
    expect(screen.getByText(explanation)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Step 6:/ }));
    metric('Final simulated key length', 'No usable key');
    expect(screen.queryByText('Experiment completed')).not.toBeInTheDocument();
  });

  it('shows a rejected sample and skips final preparation', async () => {
    const user = userEvent.setup();
    render(<SecurityLabWalkthrough result={{ ...result,
      metrics: { ...result.metrics, mismatches: 40, qber: 0.32 },
      decision: { status: 'aborted', reason: 'qber_above_threshold' },
      postProcessing: { ...result.postProcessing, status: 'skipped', reason: 'bb84_not_accepted' },
    }} />);
    expect(screen.getByText(/error level was too high, so this key must not be used/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Step 5:/ }));
    metric('Error percentage', '32.00%');
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText('Skipped')).toBeVisible();
    expect(screen.queryByText('Errors corrected')).not.toBeInTheDocument();
  });

  it('handles an empty sample without inventing a zero error rate or measurements', async () => {
    const user = userEvent.setup();
    render(<SecurityLabWalkthrough result={{ ...result, trace: [],
      metrics: { ...result.metrics, sifted: 0, sample: 0, mismatches: 0, qber: null, retained: 0 },
      decision: { status: 'aborted', reason: 'insufficient_sifted_bits' },
      postProcessing: { ...result.postProcessing, status: 'skipped', reason: 'bb84_not_accepted' },
    }} />);
    await user.click(screen.getByRole('button', { name: /Step 3:/ }));
    expect(screen.getByText(/No representative measurements/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Step 5:/ }));
    metric('Error percentage', 'Unavailable — no sample');
    expect(within(screen.getByRole('article')).queryByText('0.00%')).not.toBeInTheDocument();
  });
});
