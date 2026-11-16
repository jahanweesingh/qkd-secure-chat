import { ArrowRight, ChevronDown, FlaskConical, Laptop2, Lock, Server, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { Bb84Result, Bb84RunState } from './bb84';
import type { ConnectionInfo, EncryptionInfo } from './types';
import './encryption-story.css';

interface EncryptionStoryProps {
  encryption: EncryptionInfo;
  connection: ConnectionInfo;
  bb84State: Bb84RunState;
  bb84Result: Bb84Result | null;
  onOpenLab: () => void;
  onOpenSecurity: () => void;
}

function labStatus(state: Bb84RunState, result: Bb84Result | null): string {
  if (state === 'running') return 'Experiment running';
  if (state === 'error') return 'Result unavailable';
  if (!result) return 'Not started';
  if (result.decision.status === 'aborted') return 'Experiment stopped';
  if (result.postProcessing.status !== 'completed') return 'Sample passed · final key preparation failed';
  return 'Simulated key preparation completed';
}

/** A mechanism diagram, deliberately separate from delivery receipts and lab results. */
export function EncryptionStory({
  encryption, connection, bb84State, bb84Result, onOpenLab, onOpenSecurity,
}: EncryptionStoryProps) {
  const label = {
    idle: 'Encryption pending',
    setting_up: 'Setting up encryption',
    waiting_for_peer: 'Waiting for partner key',
    encrypted_unverified: 'Encrypted · device unverified',
    encrypted_verified: 'Encrypted · verified on this browser',
    key_changed: 'Sending paused · device key changed',
    failed: 'Encryption failed · sending paused',
  }[encryption.state];
  const encrypted = ['encrypted_unverified', 'encrypted_verified'].includes(encryption.state);
  const attention = ['key_changed', 'failed'].includes(encryption.state);
  const Icon = attention ? ShieldAlert : encryption.state === 'encrypted_verified' ? ShieldCheck : Lock;

  return (
    <details className="encryption-story">
      <summary>
        <Icon size={15} aria-hidden="true" />
        <strong>How protection works</strong>
        <span className={`encryption-story__state${attention ? ' encryption-story__state--attention' : ''}`}>{label}</span>
        <ChevronDown size={15} className="encryption-story__chevron" aria-hidden="true" />
      </summary>
      <div className="encryption-story__body">
        <div className="encryption-story__heading">
          <div>
            <h2>From your browser to theirs</h2>
            <p>How the protection works, not a live packet tracker.</p>
          </div>
          <button type="button" onClick={onOpenSecurity}>Security details <ArrowRight size={13} aria-hidden="true" /></button>
        </div>
        <ol className="encryption-story__path" aria-label="Conceptual encrypted message path">
          <li><Laptop2 size={19} aria-hidden="true" /><strong>Your browser</strong><span>Content starts here.</span></li>
          <li><Lock size={19} aria-hidden="true" /><strong>AES encryption</strong><span>Seals content before sending.</span></li>
          <li><Server size={19} aria-hidden="true" /><strong>Server relay</strong><span>Carries encrypted data.</span></li>
          <li><Laptop2 size={19} aria-hidden="true" /><strong>Their browser</strong><span>Checks and decrypts it.</span></li>
        </ol>
        <p className="encryption-story__explanation">
          {encrypted
            ? 'Browser-based ECDH and HKDF establish the AES chat keys. '
            : 'Browser-based ECDH and HKDF must establish the AES chat keys before sending. '}
          {encryption.state === 'encrypted_verified'
            ? 'The current safety code was verified on this browser.'
            : encryption.state === 'encrypted_unverified'
              ? 'Compare the safety code through another trusted channel to verify your partner’s device.'
              : encryption.state === 'key_changed'
                ? 'Review the changed device key in Security details.'
                : encryption.state === 'failed'
                  ? 'Check Security details before trying again.'
                  : 'Sending stays paused while the browsers prepare their keys.'}
        </p>
        <p className="encryption-story__connection">Connection: {connection.state === 'connected' ? 'Live' : connection.state}.
          {connection.state !== 'connected' && ' Delivery waits for the connection to return.'}
          {' '}The relay can still see participants, timing and data sizes.
        </p>
        <div className="encryption-story__lab">
          <FlaskConical size={20} aria-hidden="true" />
          <div>
            <strong>Where does BB84 fit?</strong>
            <span className="encryption-story__lab-status">{labStatus(bb84State, bb84Result)}</span>
            <p>A separate simulation explores shared-key preparation and possible interference. Its output is not used for chat encryption. This is software, not physical quantum key distribution.</p>
          </div>
          <button type="button" onClick={onOpenLab}>Open experiment <ArrowRight size={13} aria-hidden="true" /></button>
        </div>
      </div>
    </details>
  );
}
