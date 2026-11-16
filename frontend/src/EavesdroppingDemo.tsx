import { ArrowLeft, ArrowRight, Eye, EyeOff, Laptop2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Bb84Config, Bb84Result, Bb84RunState } from './bb84';
import { demonstrationConfig } from './bb84';
import './eavesdropping-demo.css';

function scenarioOf(result: Bb84Result): 'quiet' | 'eve' | null {
  const expected = demonstrationConfig(result.config.interceptProbability === 1);
  if (Object.entries(expected).some(([key, value]) => result.config[key as keyof Bb84Config] !== value)) return null;
  return result.config.interceptProbability === 1 ? 'eve' : 'quiet';
}

const percentage = (value: number | null) => value === null ? 'Not measured' : `${(value * 100).toFixed(2)}%`;

interface Props {
  result: Bb84Result | null;
  state: Bb84RunState;
  connected: boolean;
  onRun: (config: Bb84Config) => boolean;
}

/** Compares actual, completed backend runs; never synthesizes a transcript. */
export function EavesdroppingDemo({ result, state, connected, onRun }: Props) {
  const [comparison, setComparison] = useState<{ quiet?: Bb84Result; eve?: Bb84Result }>({});
  const [rowIndex, setRowIndex] = useState(0);
  useEffect(() => {
    if (!result) return;
    const scenario = scenarioOf(result);
    if (scenario) setComparison(current => ({ ...current, [scenario]: result }));
    const firstMismatch = result.trace.findIndex(row => row.sampleComparison === 'mismatch');
    setRowIndex(firstMismatch >= 0 ? firstMismatch : 0);
  }, [result]);
  const busy = state === 'running';
  // Keep a previous report available for comparison, but never show it as the current run.
  const row = !busy ? result?.trace[rowIndex] : undefined;

  return (
    <section className="eve-demo" aria-labelledby="eve-demo-title">
      <div className="eve-demo__heading">
        <div><span className="eyebrow">For your presentation</span><h3 id="eve-demo-title">What changes when Eve listens?</h3></div>
        <span className="eve-demo__tag">Two real simulation runs</span>
      </div>
      <p>Run the same teaching setup twice. Eve measures and resends the simulated information in the second run; a wrong measurement choice can introduce errors.</p>
      <div className="eve-demo__comparison">
        {(['quiet', 'eve'] as const).map(scenario => {
          const recorded = comparison[scenario];
          const withEve = scenario === 'eve';
          return (
            <article key={scenario} className={`eve-demo__case${recorded?.decision.status === 'aborted' ? ' eve-demo__case--stopped' : ''}`} aria-label={withEve ? 'With Eve comparison' : 'Without Eve comparison'}>
              <div className="eve-demo__case-title">{withEve ? <Eye size={19} aria-hidden="true" /> : <EyeOff size={19} aria-hidden="true" />}<h4>{withEve ? 'With Eve' : 'Without Eve'}</h4><span>{withEve ? '100% interception' : '0% interception'}</span></div>
              <div className="eve-demo__reading"><strong>{recorded ? percentage(recorded.metrics.qber) : '—'}</strong><span>{recorded ? 'Measured error rate' : 'No recorded run yet'}</span></div>
              {recorded ? <>
                <p className="eve-demo__outcome">{recorded.decision.status === 'aborted' ? 'Experiment stopped' : recorded.postProcessing.status === 'completed' ? 'Simulated key prepared' : 'Sample passed; key preparation stopped'}</p>
                <p>{recorded.metrics.mismatches} mismatches / {recorded.metrics.sample} checked · limit {percentage(recorded.config.qberThreshold)}</p>
                <small>Recorded at {new Date(recorded.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>
              </> : <p>The error rate appears only after the room host returns a result.</p>}
              <button type="button" disabled={!connected || busy} onClick={() => onRun(demonstrationConfig(withEve))}><Play size={14} aria-hidden="true" />{withEve ? 'Run with Eve' : 'Run without Eve'}</button>
            </article>
          );
        })}
      </div>
      <p className="eve-demo__settings">Both presets: 1,024 transmissions · no background noise · 25% checked · 11% error limit · teaching seed 7. Runs are repeatable; this seed is public, not secret.</p>
      {busy && <p role="status" className="eve-demo__waiting">Waiting for the complete result. The model does not stream individual transmissions.</p>}
      {!connected && <p className="eve-demo__waiting">Reconnect to the room to run this comparison.</p>}
      {row && result && <div className="eve-demo__transmission">
        <div className="eve-demo__row-heading"><h4>One recorded transmission</h4><span>Position {row.index + 1} of {result.metrics.transmitted}</span></div>
        <ol className="eve-demo__path" aria-label="Recorded simulated transmission">
          <li><Laptop2 size={24} aria-hidden="true" /><strong>Alice prepares</strong><span className="eve-demo__basis">{row.aliceBasis === 'Z' ? '+' : '×'}</span><span>{row.aliceBasis === 'Z' ? 'Straight basis (Z)' : 'Diagonal basis (X)'}</span></li>
          <li className={row.intercepted ? 'eve-demo__intercepted' : ''}>{row.intercepted ? <Eye size={24} aria-hidden="true" /> : <EyeOff size={24} aria-hidden="true" />}<strong>{row.intercepted ? 'Eve intercepts' : 'Eve does not intercept'}</strong><span>{row.intercepted ? 'Measures and resends in the model.' : 'This simulated transmission passes directly.'}</span><small>Simulator knowledge</small></li>
          <li><Laptop2 size={24} aria-hidden="true" /><strong>Bob measures</strong><span className="eve-demo__basis">{row.bobBasis === 'Z' ? '+' : '×'}</span><span>{row.bobBasis === 'Z' ? 'Straight basis (Z)' : 'Diagonal basis (X)'}</span></li>
        </ol>
        <p className={`eve-demo__sample${row.sampleComparison === 'mismatch' ? ' eve-demo__sample--mismatch' : ''}`}>
          {!row.basisMatch ? 'Different choices: this position is discarded.' : row.sampleComparison === 'mismatch' ? 'Same choices, different sample results: an error is counted.' : row.sampleComparison === 'match' ? 'Same choices and matching sample results: no error in this checked position.' : 'Same choices: retained for the experiment. This position was not publicly sampled.'}
        </p>
        <div className="eve-demo__row-controls"><button type="button" aria-label="Previous recorded transmission" disabled={rowIndex === 0} onClick={() => setRowIndex(index => index - 1)}><ArrowLeft size={16} aria-hidden="true" />Previous</button><span>{rowIndex + 1} / {result.trace.length} disclosed trace rows</span><button type="button" aria-label="Next recorded transmission" disabled={rowIndex >= result.trace.length - 1} onClick={() => setRowIndex(index => index + 1)}>Next<ArrowRight size={16} aria-hidden="true" /></button></div>
        <small>Review of the latest completed run, not live photons. Secret bit values and Eve’s private measurement choices are not shown.</small>
      </div>}
      <aside className="eve-demo__boundary"><strong>Listening to network packets is a different demonstration.</strong> Wireshark observes the already encrypted chat traffic. This BB84 model does not detect packet sniffers, and its results never change the chat keys. A low error rate does not prove Eve is absent.</aside>
    </section>
  );
}
