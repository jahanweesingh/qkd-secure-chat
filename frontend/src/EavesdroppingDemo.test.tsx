import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EavesdroppingDemo } from './EavesdroppingDemo';
import { demonstrationConfig } from './bb84';
import type { Bb84Result } from './bb84';

function report(eve: boolean, mismatches = eve ? 33 : 0): Bb84Result {
  return {
    sessionId: eve ? 'eve-run' : 'quiet-run', startedBy: 'alice', createdAt: '2026-11-13T07:00:00Z', simulationOnly: true, chatEncryptionActive: false,
    config: demonstrationConfig(eve), metrics: { transmitted: 1024, intercepted: eve ? 1024 : 0, sifted: 527, sample: 132, mismatches, qber: mismatches / 132, retained: 395 },
    decision: { status: eve ? 'aborted' : 'accepted', reason: eve ? 'qber_above_threshold' : 'qber_within_threshold' },
    postProcessing: { version: 'phase3-post-processing-v1', status: eve ? 'skipped' : 'completed', reason: eve ? 'bb84_not_accepted' : 'completed', inputBits: 395,
      reconciliation: { algorithm: 'cascade-inspired-parity-v1', passes: 4, correctedErrors: 0, remainingErrors: 0, leakedBits: 7, verified: true },
      privacyAmplification: { algorithm: 'toeplitz-universal-hash-v1', entropyModel: 'illustrative-asymptotic-bb84-binary-entropy-v1', securityMarginBits: 32, estimatedSecretBits: 356, outputBits: 128 },
      confirmation: { algorithm: 'hmac-sha256-truncated-v1', tagBits: 128, passed: !eve },
      derivation: { algorithm: 'hkdf-sha256-v1', outputBits: 256, contextBound: true, materialRetained: false },
      keyMaterialExposed: false, keyUsedForChat: false, reproducibleTeachingRun: true },
    trace: [
      { index: 4, aliceBasis: 'Z', bobBasis: 'X', basisMatch: false, intercepted: eve, sampled: false, sampleComparison: null },
      { index: 11, aliceBasis: 'X', bobBasis: 'X', basisMatch: true, intercepted: eve, sampled: true, sampleComparison: eve ? 'mismatch' : 'match' },
    ],
  };
}

describe('panel eavesdropping comparison', () => {
  it('sends both real presets without inventing results', async () => {
    const user = userEvent.setup(); const onRun = vi.fn(() => true);
    render(<EavesdroppingDemo result={null} state="idle" connected onRun={onRun} />);
    expect(screen.getAllByText('No recorded run yet')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Run without Eve' }));
    expect(onRun).toHaveBeenLastCalledWith(demonstrationConfig(false));
    await user.click(screen.getByRole('button', { name: 'Run with Eve' }));
    expect(onRun).toHaveBeenLastCalledWith(demonstrationConfig(true));
    expect(screen.getAllByText('No recorded run yet')).toHaveLength(2);
    expect(screen.queryByText('Experiment stopped')).not.toBeInTheDocument();
  });

  it('retains two actual reports and depicts only the selected disclosed transmission', async () => {
    const user = userEvent.setup(); const onRun = vi.fn(() => true);
    const { rerender } = render(<EavesdroppingDemo result={report(false)} state="complete" connected onRun={onRun} />);
    expect(within(screen.getByRole('article', { name: 'Without Eve comparison' })).getByText('0.00%')).toBeVisible();
    rerender(<EavesdroppingDemo result={report(true, 40)} state="complete" connected onRun={onRun} />);
    expect(within(screen.getByRole('article', { name: 'With Eve comparison' })).getByText('30.30%')).toBeVisible();
    expect(screen.getByText('Simulated key prepared')).toBeVisible();
    expect(screen.getByText('Experiment stopped')).toBeVisible();
    expect(screen.getByText('Position 12 of 1024')).toBeVisible();
    expect(screen.getByText(/Same choices, different sample results/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Previous recorded transmission' }));
    expect(screen.getByText('Position 5 of 1024')).toBeVisible();
    expect(screen.getByText(/Different choices: this position is discarded/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous recorded transmission' })).toBeDisabled();
    expect(screen.getByText(/does not detect packet sniffers/)).toBeVisible();
    expect(screen.getByText(/not live photons/)).toBeVisible();
  });

  it('does not relabel a custom experiment as one of the comparison presets', () => {
    const result = report(false); result.config.noiseProbability = 0.1;
    render(<EavesdroppingDemo result={result} state="complete" connected onRun={vi.fn()} />);
    expect(screen.getAllByText('No recorded run yet')).toHaveLength(2);
    expect(screen.getByText('One recorded transmission')).toBeVisible();
  });

  it('keeps sample acceptance separate from completed key preparation', () => {
    const result = report(false); result.postProcessing.status = 'failed'; result.postProcessing.reason = 'insufficient_entropy';
    render(<EavesdroppingDemo result={result} state="complete" connected onRun={vi.fn()} />);
    expect(screen.getByText('Sample passed; key preparation stopped')).toBeVisible();
    expect(screen.queryByText('Simulated key prepared')).not.toBeInTheDocument();
  });

  it('disables duplicate runs and hides the old transmission while awaiting a new report', () => {
    const { rerender } = render(<EavesdroppingDemo result={report(true)} state="running" connected onRun={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Run with Eve' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('does not stream individual transmissions');
    expect(screen.queryByText('One recorded transmission')).not.toBeInTheDocument();
    rerender(<EavesdroppingDemo result={null} state="idle" connected={false} onRun={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Run without Eve' })).toBeDisabled();
    expect(screen.getByText(/Reconnect to the room/)).toBeVisible();
  });
});
