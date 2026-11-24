import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Eye, Lock, UserRound } from 'lucide-react';
import type { Bb84Basis, Bb84Result } from './bb84';
import type { EndpointBb84Progress } from './bb84ChatSession';
import type { ConnectionInfo, EncryptionInfo } from './types';
import { getEndpointBb84RuntimeStatus } from './bb84RuntimeStatus';
import './security-lab.css';

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const reviewLabels = ['Prepare information', 'Send information', 'Measure results', 'Keep matching choices', 'Check for interference', 'Prepare the key', 'Read the result'];

export function EndpointBb84RuntimeSummary({ encryption, endpointBb84 }: {
  encryption: EncryptionInfo;
  endpointBb84: EndpointBb84Progress;
}) {
  const status = getEndpointBb84RuntimeStatus(encryption, endpointBb84);
  return <dl className="lab-endpoint-runtime" role="region" aria-label="Endpoint BB84 and chat key status">
    <div><dt>BB84 session</dt><dd>{status.session}{endpointBb84.status !== 'idle' && endpointBb84.role ? ` · ${endpointBb84.role === 'alice' ? 'Alice' : 'Bob'} · ${endpointBb84.status.replaceAll('_', ' ')}` : ''}</dd></div>
    <div><dt>Chat encryption</dt><dd>{status.chatMode}</dd></div>
    <div><dt>BB84 key contribution</dt><dd>{status.contribution}</dd></div>
    <div><dt>Contribution in chat encryption</dt><dd>{status.contributionInChat}</dd></div>
    <div><dt>Basis reconciliation</dt><dd>{status.reconciliation}</dd></div>
    <div><dt>Privacy amplification</dt><dd>{status.privacyAmplification}</dd></div>
    <div><dt>Mutual key confirmation</dt><dd>{status.keyConfirmation}</dd></div>
    <div><dt>Active hybrid epoch</dt><dd>{status.hybridEpoch}</dd></div>
  </dl>;
}

export function ChatKeyModeSummary({ encryption, endpointBb84 }: {
  encryption: EncryptionInfo;
  endpointBb84: EndpointBb84Progress;
}) {
  const status = getEndpointBb84RuntimeStatus(encryption, endpointBb84);
  const mode = status.chatMode === 'BB84-ECDH hybrid active' ? 'BB84 + ECDH Hybrid'
    : status.chatMode === 'ECDH-only' ? 'ECDH-only' : 'No active chat key';
  const contribution = status.contribution === 'Confirmed' && status.contributionInChat !== 'Active in hybrid epoch'
    ? 'Confirmed · inactive in current chat mode'
    : status.contribution;
  return <section className="chat-security-summary" aria-label="Current chat security" role="status">
    <div className="chat-security-summary__mode">
      <span>Current encryption mode</span>
      <strong>{mode}</strong>
    </div>
    <div className="chat-security-summary__indicators">
      <span>BB84 contribution <strong>{contribution}</strong></span>
      <span>Mutual key confirmation <strong>{status.keyConfirmation}</strong></span>
    </div>
    <p>Message encryption <strong>AES-256-GCM</strong></p>
  </section>;
}

export function ChatProtectionSummary({ encryption, endpointBb84, connection }: {
  encryption: EncryptionInfo;
  endpointBb84: EndpointBb84Progress;
  connection: ConnectionInfo;
}) {
  const active = encryption.state === 'encrypted_unverified' || encryption.state === 'encrypted_verified';

  return (
    <section className="lab-protection" aria-labelledby="lab-protection-title">
      <h3 id="lab-protection-title">Current chat protection</h3>
      <ChatKeyModeSummary encryption={encryption} endpointBb84={endpointBb84} />
      <p className="lab-protection__connection">{active ? `Safety code ${encryption.state === 'encrypted_verified' ? 'verified' : 'not verified'}` : 'Encryption is not ready'} · Connection {connection.state}.</p>
    </section>
  );
}

export function LabParticipants() {
  return (
    <div className="lab-people" aria-label="People in the simulation">
      <div className="lab-person lab-person--alice"><UserRound aria-hidden="true" /><span><strong>Alice</strong><small>Sends the information.</small></span></div>
      <div className="lab-person lab-person--bob"><UserRound aria-hidden="true" /><span><strong>Bob</strong><small>Receives and measures it.</small></span></div>
      <div className="lab-person lab-person--eve"><Eye aria-hidden="true" /><span><strong>Eve</strong><small>Represents someone trying to intercept the exchange.</small></span></div>
    </div>
  );
}

function Basis({ basis }: { basis: Bb84Basis }) {
  return <span className="lab-encoding"><b aria-hidden="true">{basis === 'Z' ? '+' : '×'}</b> {basis === 'Z' ? 'Straight' : 'Diagonal'}</span>;
}

function Metrics({ values }: { values: Array<[string, string | number]> }) {
  return <dl className="lab-simple-metrics">{values.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
  ))}</dl>;
}

function experimentOutcome(result: Bb84Result): { success: boolean; detail: string; next: string } {
  if (result.decision.reason === 'qber_above_threshold') return {
    success: false,
    detail: 'The measured error level was too high, so this key must not be used.',
    next: 'Try less interception or less background noise, then run another experiment.',
  };
  if (result.decision.reason === 'insufficient_sifted_bits') return {
    success: false,
    detail: 'Too few matching results remained to check the exchange. No usable key was produced.',
    next: 'Prepare more bits and run another experiment.',
  };
  const processing = result.postProcessing;
  if (processing.status === 'completed') return {
    success: true,
    detail: 'Both participants completed the simulated key-generation process.',
    next: 'Try increasing Eve’s interception and compare the error level. This room-hosted teaching run does not set chat keys; endpoint-owned BB84 can establish the hybrid chat epoch after mutual confirmation.',
  };
  if (processing.reason === 'insufficient_entropy') return {
    success: false,
    detail: 'The error check passed, but too little estimated secret information remained to prepare a key.',
    next: 'Prepare more bits or reduce noise and interception, then try again.',
  };
  if (processing.reason === 'reconciliation_failed') return {
    success: false,
    detail: 'The error check passed, but the remaining differences could not be corrected.',
    next: 'Try less noise or interception. This run must not supply a key.',
  };
  return {
    success: false,
    detail: processing.reason === 'confirmation_failed'
      ? 'The final agreement check failed. The temporary material was discarded.'
      : 'The final preparation check failed. The temporary material was discarded.',
    next: 'Run another experiment. If this repeats, inspect the technical details with your mentor.',
  };
}

export function SecurityLabWalkthrough({ result }: { result: Bb84Result }) {
  const [selected, setSelected] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const focusStep = useRef(false);
  useEffect(() => {
    if (focusStep.current) stepHeading.current?.focus();
    focusStep.current = false;
  }, [selected]);
  const { metrics: m, postProcessing: p } = result;
  const outcome = experimentOutcome(result);
  const rows = result.trace.slice(0, 6);
  const corrected = p.status !== 'skipped';
  const steps: Array<{ title: string; description: string; status: string; content: ReactNode }> = [
    {
      title: 'Alice prepares the information', status: 'Completed',
      description: 'Alice creates a random sequence of 0s and 1s. She also randomly chooses how to encode each one.',
      content: <>
        <Metrics values={[["Bits prepared", m.transmitted]]} />
        <p>Two encoding choices: <Basis basis="Z" /> <Basis basis="X" /></p>
        <div className="lab-private-sample" aria-label="Selected positions with secret values hidden">
          {rows.map((row) => <span key={row.index}><Lock size={15} aria-hidden="true" /><small>#{row.index + 1}</small><Basis basis={row.aliceBasis} /></span>)}
        </div>
        <p className="lab-small-note">These are selected positions from this run. Secret 0s and 1s stay hidden; only encoding choices are shown.</p>
      </>,
    },
    {
      title: 'The information is sent', status: 'Completed',
      description: 'Alice sends the prepared information to Bob. Eve may try to intercept some of it.',
      content: <>
        <div className="lab-transmission" aria-label="Simulated path: Alice, Eve's interception point, Bob">
          <span>Alice</span><ArrowRight aria-hidden="true" /><span><Eye size={18} aria-hidden="true" /> Eve’s interception point</span><ArrowRight aria-hidden="true" /><span>Bob</span>
        </div>
        <Metrics values={[
          ['Interception setting', result.config.interceptProbability > 0 ? 'Enabled' : 'Off'],
          ['Configured chance', percent(result.config.interceptProbability)],
          ['Actually intercepted', `${m.intercepted} of ${m.transmitted}`],
          ['Intercepted share', percent(m.intercepted / m.transmitted)],
        ]} />
        <p className="lab-small-note">This is a software simulation, not photon transmission. The simulator knows Eve’s activity; Alice and Bob would not directly know this count in a real exchange.</p>
      </>,
    },
    {
      title: 'Bob measures what he receives', status: 'Completed',
      description: 'Bob independently chooses how to read each piece of information. If he chooses the same method as Alice, the result should match in an ideal experiment.',
      content: <>
        <ul className="lab-basis-examples" aria-label="Selected measurements from this run">
          {rows.map((row) => <li key={row.index}>
            <span>Position {row.index + 1}</span>
            <span>Alice <Basis basis={row.aliceBasis} /></span>
            <span>Bob <Basis basis={row.bobBasis} /></span>
            <strong>{row.basisMatch ? 'Same choice' : 'Different choices'}</strong>
            <small>{row.sampled ? `Checked sample: ${row.sampleComparison === 'match' ? 'results match' : 'results differ'}` : 'Bit result kept private'}</small>
          </li>)}
        </ul>
        {!rows.length && <p>No representative measurements were included in this report.</p>}
      </>,
    },
    {
      title: 'They keep only the matching results', status: 'Completed',
      description: 'Alice and Bob compare their choices, not their secret bit values. They discard positions where they used different methods.',
      content: <>
        <div className="lab-retained-track" role="img" aria-label={`${m.sifted} matching positions out of ${m.transmitted} sent`}>
          <span style={{ width: `${m.sifted / m.transmitted * 100}%` }} />
        </div>
        <Metrics values={[
          ['Total bits sent', m.transmitted], ['Matching positions', m.sifted],
          ['Discarded positions', m.transmitted - m.sifted], ['Candidates before checking', m.sifted],
          ['Candidates after sample removal', m.retained],
        ]} />
        <p className="lab-small-note">The next step reveals a sample for checking. Those {m.sample} positions cannot remain in the candidate key.</p>
      </>,
    },
    {
      title: 'They check whether anything went wrong', status: result.decision.status === 'accepted' ? 'Passed' : 'Stopped',
      description: 'Alice and Bob compare a small sample of their results. If too many values differ, someone may have interfered with the exchange, or errors may have occurred.',
      content: <>
        <Metrics values={[
          ['Sample bits checked', m.sample], ['Mismatches', m.mismatches],
          ['Error percentage', m.qber === null ? 'Unavailable — no sample' : percent(m.qber)],
          ['Acceptable threshold', percent(result.config.qberThreshold)],
        ]} />
        <p className="lab-step-verdict">{result.decision.status === 'accepted'
          ? 'The error level is within the configured limit.'
          : result.decision.reason === 'qber_above_threshold'
            ? 'The error level is too high. The experiment must stop.'
            : 'There is not enough information to check. The experiment must stop.'}</p>
        <p>A low error rate does not prove Eve is absent. Noise can also cause differences.</p>
      </>,
    },
    {
      title: 'They prepare the final shared key', status: p.status === 'completed' ? 'Completed' : p.status === 'skipped' ? 'Skipped' : 'Stopped',
      description: 'They correct remaining differences, then shorten the shared information to reduce what an observer might have learned.',
      content: <>
        <p><strong>Error correction:</strong> They correct remaining differences so both participants have matching information.</p>
        <p><strong>Privacy amplification:</strong> They shorten the shared information to reduce what an observer might have learned.</p>
        {corrected ? <Metrics values={[
          ['Errors corrected', p.reconciliation.correctedErrors],
          ['Remaining errors', p.reconciliation.remainingErrors],
          ['Information disclosed during correction', `${p.reconciliation.leakedBits} bits`],
          ['Estimated secret bits (teaching estimate)', `${p.privacyAmplification.estimatedSecretBits} bits`],
          ['Final simulated key length', outcome.success ? `${p.privacyAmplification.outputBits} bits` : 'No usable key'],
        ]} /> : <p>Skipped because the earlier check did not pass. No final key was prepared.</p>}
        <p className="lab-small-note">The estimate is illustrative, not a security proof. Temporary material stays inside the simulator and is discarded; it never becomes a chat key.</p>
      </>,
    },
    {
      title: 'Final result', status: outcome.success ? 'Completed' : 'Stopped',
      description: outcome.detail,
      content: <><p>{outcome.next}</p><p>Chat continues to use its separate browser encryption. This experiment cannot change or verify those keys.</p></>,
    },
  ];

  function selectStep(index: number, focus = false) {
    focusStep.current = focus;
    setSelected(index);
  }

  return (
    <section className="lab-walkthrough" aria-label="Guided experiment walkthrough">
      <div className="lab-review-heading">
        <div>
          <span className="lab-notebook-caption">Experiment notebook</span>
          <h3>Follow the exchange</h3>
          <p>Review the completed result at your own pace. These are recorded results, not live transmission.</p>
        </div>
        <button type="button" onClick={() => setShowAll(!showAll)} aria-expanded={showAll} aria-controls="lab-step-content">{showAll ? 'Show one step' : 'Show all steps'}</button>
      </div>
      <div className={`lab-outcome ${outcome.success ? 'lab-outcome--success' : 'lab-outcome--stopped'}`} role="status" aria-atomic="true">
        <strong>{outcome.success ? 'Experiment completed' : 'Experiment stopped'}</strong>
        <p>{outcome.detail}</p>
        <p>{outcome.next}</p>
      </div>
      <div className={`lab-notebook${showAll ? ' lab-notebook--all' : ''}`}>
        <div className="lab-notebook-index">
          <label className="lab-review-progress">{showAll ? 'All 7 steps' : `Review step ${selected + 1} of 7`}
            <progress aria-label="Walkthrough review progress" max={7} value={showAll ? 7 : selected + 1} />
          </label>
          {!showAll && <nav className="lab-step-nav" aria-label="Experiment review steps">
            {steps.map((step, index) => <button type="button" key={step.title}
              aria-label={`Step ${index + 1}: ${step.title}`}
              aria-current={selected === index ? 'step' : undefined}
              onClick={() => selectStep(index)}>
              <span className="lab-step-number" aria-hidden="true">{index + 1}</span>
              <span>{reviewLabels[index]}</span>
            </button>)}
          </nav>}
        </div>
        <div className="lab-notebook-sheet">
          <div id="lab-step-content">
            {steps.map((step, index) => (showAll || index === selected) && <article className="lab-review-step" key={step.title} aria-label={`Step ${index + 1}`}>
              <div className="lab-review-step__top"><span>Step {index + 1} of 7</span><span className={`lab-step-status lab-step-status--${step.status.toLowerCase()}`}>{step.status === 'Completed' && <Check size={14} aria-hidden="true" />}{step.status}</span></div>
              <h4 ref={index === selected ? stepHeading : undefined} tabIndex={-1}>{step.title}</h4>
              <p className="lab-step-description">{step.description}</p>
              {step.content}
            </article>)}
          </div>
          {!showAll && <div className="lab-review-actions">
            <button type="button" disabled={selected === 0} onClick={() => selectStep(selected - 1, true)}><ArrowLeft size={16} aria-hidden="true" /> Previous step</button>
            <button type="button" disabled={selected === 6} onClick={() => selectStep(selected + 1, true)}>Next step <ArrowRight size={16} aria-hidden="true" /></button>
          </div>}
        </div>
      </div>
    </section>
  );
}
