import { useId, useState } from 'react';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, Circle,
  Eye, FlaskConical, KeyRound, Laptop2, Lock, Radio, Server, ShieldAlert, ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SecurityTraceEvent, SecurityTraceKind } from './securityTrace';
import type { ConnectionInfo, EncryptionInfo } from './types';
import './live-security.css';

export interface LiveSecurityViewProps {
  events: SecurityTraceEvent[];
  connection: ConnectionInfo;
  encryption: EncryptionInfo;
  onClear: () => void;
  onOpenLab: () => void;
  onOpenSecurity: () => void;
}

type Direction = 'outgoing' | 'incoming';
type StageTone = 'observed' | 'waiting' | 'unknown' | 'failed';

interface MessageStage {
  title: string;
  detail: string;
  evidence: string;
  tone: StageTone;
  icon: LucideIcon;
}

const EVENT_LABELS: Record<SecurityTraceKind, string> = {
  identity_ready: 'Browser identity ready',
  public_key_sent: 'Public key sent',
  peer_key_received: 'Partner public key received',
  keys_derived: 'Directional chat keys derived',
  key_changed: 'Device key changed',
  message_encrypted: 'Message encrypted in this browser',
  ciphertext_sent: 'Encrypted envelope handed to WebSocket',
  relay_accepted: 'Server accepted the encrypted envelope',
  ciphertext_received: 'Encrypted envelope received',
  message_decrypted: 'Message authenticated and decrypted here',
  integrity_failed: 'Message failed its integrity check',
  encryption_failed: 'Encryption failed; sending paused',
  message_failed: 'Message send failed',
  connection_closed: 'Connection closed',
};

function eventLabel(event: SecurityTraceEvent): string {
  if (event.direction === 'outgoing' && event.kind === 'ciphertext_received') return 'Your encrypted relay echo received';
  if (event.direction === 'outgoing' && event.kind === 'message_decrypted') return 'Your relay echo authenticated locally';
  return EVENT_LABELS[event.kind];
}

function clockLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'Time unavailable';
  return new Date(timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isFailure(event: SecurityTraceEvent): boolean {
  return ['integrity_failed', 'encryption_failed', 'message_failed', 'key_changed'].includes(event.kind);
}

function latestSendOutcome(events: SecurityTraceEvent[]): SecurityTraceEvent | undefined {
  // Retries reuse the same client message ID. An older failure or acknowledgement
  // describes that earlier attempt, not a later WebSocket send.
  return [...events].reverse().find((event) => [
    'message_encrypted', 'ciphertext_sent', 'relay_accepted', 'message_failed',
  ].includes(event.kind));
}

function outgoingStages(events: SecurityTraceEvent[]): MessageStage[] {
  const encrypted = events.some((event) => event.kind === 'message_encrypted');
  const outcome = latestSendOutcome(events);
  const sent = outcome?.kind === 'ciphertext_sent';
  const accepted = outcome?.kind === 'relay_accepted';
  const failed = outcome?.kind === 'message_failed';
  const earlierEncryptionMissing = !encrypted && events.some((event) =>
    event.kind === 'ciphertext_sent' || event.kind === 'relay_accepted');
  return [
    { title: 'This browser', icon: Laptop2, detail: 'The message starts at your endpoint.',
      evidence: encrypted ? 'Local encryption observed' : earlierEncryptionMissing ? 'Not retained in this view' : 'Send a message to begin',
      tone: encrypted ? 'observed' : earlierEncryptionMissing ? 'unknown' : 'waiting' },
    { title: 'AES encryption', icon: Lock, detail: 'AES-GCM seals the content before it leaves.',
      evidence: encrypted ? 'Encrypted locally' : earlierEncryptionMissing ? 'Not retained in this view' : 'Waiting for encryption',
      tone: encrypted ? 'observed' : earlierEncryptionMissing ? 'unknown' : 'waiting' },
    { title: 'Server relay', icon: Server, detail: 'The server carries the encrypted envelope.',
      evidence: failed ? 'Send failed' : accepted ? 'Accepted by server' : sent ? 'Awaiting acknowledgement' : 'Waiting for an envelope',
      tone: failed ? 'failed' : accepted ? 'observed' : 'waiting' },
    { title: 'Partner browser', icon: Laptop2, detail: 'Show this view on the receiving Mac to see decryption.',
      evidence: 'Not observed here', tone: 'unknown' },
  ];
}

function incomingStages(events: SecurityTraceEvent[]): MessageStage[] {
  const received = events.some((event) => event.kind === 'ciphertext_received');
  const decrypted = events.some((event) => event.kind === 'message_decrypted');
  const failed = events.some((event) => event.kind === 'integrity_failed');
  return [
    { title: 'Partner browser', icon: Laptop2, detail: 'The sending Mac has its own local observations.',
      evidence: 'Not observed here', tone: 'unknown' },
    { title: 'Server relay', icon: Server, detail: 'An encrypted envelope arrives from the server.',
      evidence: received ? 'Envelope received' : decrypted || failed ? 'Receipt event not retained' : 'Waiting for a message',
      tone: received ? 'observed' : decrypted || failed ? 'unknown' : 'waiting' },
    { title: 'AES integrity check', icon: ShieldCheck, detail: 'This browser checks the tag before opening the content.',
      evidence: failed ? 'Authentication failed' : decrypted ? 'Checked and decrypted' : received ? 'Checking locally' : 'Waiting for ciphertext',
      tone: failed ? 'failed' : decrypted ? 'observed' : 'waiting' },
    { title: 'This browser', icon: Laptop2, detail: 'Authenticated content becomes available at this endpoint.',
      evidence: failed ? 'Content withheld' : decrypted ? 'Authenticated locally' : 'Not opened yet',
      tone: failed ? 'failed' : decrypted ? 'observed' : 'waiting' },
  ];
}

/** Local, observational evidence only. A relay ACK never completes a remote stage. */
export function LiveSecurityView({ events, connection, encryption, onClear, onOpenLab, onOpenSecurity }: LiveSecurityViewProps) {
  const headingId = useId();
  const [chosenDirection, setChosenDirection] = useState<Direction | null>(null);
  const [showAll, setShowAll] = useState(false);
  const liveEvents = events.filter((event) => event.source === 'live');
  const latestMessage = [...liveEvents].reverse().find((event) => event.messageId && event.direction);
  const direction = chosenDirection ?? latestMessage?.direction ?? 'outgoing';
  const latest = [...liveEvents].reverse().find((event) => event.direction === direction && event.messageId);
  const related = latest
    ? liveEvents.filter((event) => event.direction === direction && event.messageId === latest.messageId)
    : [];
  const stages = direction === 'outgoing' ? outgoingStages(related) : incomingStages(related);
  const payload = [...related].reverse().find((event) => event.ciphertextPreview && /^[A-Za-z0-9_-]{1,32}$/.test(event.ciphertextPreview));
  const latestEvent = liveEvents.at(-1);
  const timeline = [...liveEvents].reverse().slice(0, showAll ? 60 : 8);
  const active = encryption.state === 'encrypted_unverified' || encryption.state === 'encrypted_verified';
  const attention = encryption.state === 'failed' || encryption.state === 'key_changed';
  const encryptionLabel = active ? 'Active' : encryption.state === 'failed' ? 'Failed'
    : encryption.state === 'key_changed' ? 'Paused · key changed'
      : encryption.state === 'waiting_for_peer' ? 'Waiting for partner' : 'Setting up';
  const verificationLabel = encryption.state === 'encrypted_verified' ? 'Verified on this browser' : 'Not verified here';
  const lastFailure = [...related].reverse().find((event) => isFailure(event));
  const messageFailure = direction === 'outgoing' && lastFailure?.kind === 'message_failed'
    && latestSendOutcome(related)?.kind !== 'message_failed' ? undefined : lastFailure;

  return (
    <section className="live-security" aria-labelledby={headingId}>
      <header className="live-security__intro">
        <div>
          <span className="live-security__eyebrow"><Radio size={15} aria-hidden="true" /> Live browser observations</span>
          <h2 id={headingId}>Follow the encrypted exchange</h2>
          <p>Send a message from either Mac. This view updates when this browser completes real operations.</p>
        </div>
        <button className="live-security__button" type="button" onClick={onOpenSecurity}>
          <KeyRound size={16} aria-hidden="true" /> Security details
        </button>
      </header>

      <dl className="live-security__statuses">
        <div><dt>Connection</dt><dd>{connection.state === 'connected' ? 'Live' : connection.state}</dd></div>
        <div className={attention ? 'live-security__attention' : undefined}><dt>Chat encryption</dt><dd>{encryptionLabel}</dd></div>
        <div><dt>Safety code</dt><dd>{verificationLabel}</dd></div>
      </dl>

      {attention && <p className="live-security__notice live-security__notice--danger" role="status">
        <ShieldAlert size={18} aria-hidden="true" />
        {encryption.state === 'key_changed'
          ? 'Sending is paused because a device key changed. Review the new safety code in Security details.'
          : 'Sending is paused because encryption failed. Open Security details to review and retry.'}
      </p>}
      {connection.state !== 'connected' && <p className="live-security__notice" role="status">
        Earlier observations stay visible. New message delivery waits for the connection to return.
      </p>}

      <section className="live-security__journey" aria-label="Observed message journey">
        <div className="live-security__journey-heading">
          <div><h3>{direction === 'outgoing' ? 'Sending from this browser' : 'Receiving in this browser'}</h3>
            <p>{latest ? `Latest envelope · ${clockLabel(latest.timestamp)} on this Mac` : 'No live envelope observed in this direction yet.'}</p></div>
          <div className="live-security__direction" role="group" aria-label="Message direction">
            <button type="button" aria-pressed={direction === 'outgoing'} onClick={() => setChosenDirection('outgoing')}>
              <ArrowUpRight size={16} aria-hidden="true" /> Sending
            </button>
            <button type="button" aria-pressed={direction === 'incoming'} onClick={() => setChosenDirection('incoming')}>
              <ArrowDownLeft size={16} aria-hidden="true" /> Receiving
            </button>
          </div>
        </div>

        <ol className="live-security__path" aria-label={direction === 'outgoing' ? 'Outgoing message evidence' : 'Incoming message evidence'}>
          {stages.map(({ title, icon: Icon, evidence, detail, tone }) => (
            <li key={title} className={`live-security__stage live-security__stage--${tone}`}>
              <span className="live-security__stage-icon"><Icon size={25} aria-hidden="true" /></span>
              <h4>{title}</h4>
              <p>{detail}</p>
              <span className="live-security__evidence">
                {tone === 'observed' ? <Check size={14} aria-hidden="true" /> : tone === 'failed' ? <ShieldAlert size={14} aria-hidden="true" /> : <Circle size={10} aria-hidden="true" />}
                {evidence}
              </span>
            </li>
          ))}
        </ol>

        <p className="live-security__proof-note">
          {direction === 'outgoing'
            ? 'A server acknowledgement confirms acceptance for relay and storage. It does not confirm that the partner decrypted the message.'
            : '“Authenticated locally” appears only after this browser successfully checks and decrypts the received envelope.'}
        </p>
        {messageFailure && <p className="live-security__notice live-security__notice--danger" role="status">{eventLabel(messageFailure)}. No successful completion is inferred.</p>}

        {payload && <div className="live-security__sealed" aria-label="Observed encrypted payload">
          <Lock size={20} aria-hidden="true" />
          <div><strong>Encrypted payload observed here</strong>
            <code>{payload.ciphertextPreview}…</code>
            <p>Actual ciphertext prefix, shortened for display.
              {Number.isSafeInteger(payload.bytes) && (payload.bytes ?? 0) > 0 ? ` Envelope ciphertext and tag: ${payload.bytes} bytes.` : ''}
              {' '}No message text or secret key is shown.</p>
          </div>
        </div>}
        {!latest && <p className="live-security__empty">
          {direction === 'outgoing'
            ? 'Send a chat message from this Mac to follow local encryption and relay acceptance.'
            : 'Ask your partner to send a chat message from the other Mac. This browser will show its integrity check and decryption here.'}
        </p>}
      </section>

      <div className="live-security__lower">
        <section className="live-security__activity" aria-label="Recent security observations">
          <div className="live-security__section-heading"><h3>What just happened</h3>
            <button className="live-security__button live-security__button--quiet" type="button" onClick={onClear} disabled={events.length === 0}>Clear observations</button>
          </div>
          <p className="live-security__announcement" role="status" aria-live="polite" aria-atomic="true">
            {latestEvent ? `Latest: ${eventLabel(latestEvent)}.` : 'Waiting for an observed operation.'}
          </p>
          {timeline.length > 0 ? <ol className="live-security__timeline" aria-label="Local observation timeline">
            {timeline.map((event) => <li key={event.id} className={isFailure(event) ? 'live-security__timeline-failure' : undefined}>
              <span className="live-security__timeline-mark" aria-hidden="true">{isFailure(event) ? <ShieldAlert size={14} /> : <Check size={13} />}</span>
              <div><strong>{eventLabel(event)}</strong>
                <span>{event.direction === 'outgoing' ? 'Outgoing envelope' : event.direction === 'incoming' ? 'Incoming envelope' : 'Browser setup'} · {clockLabel(event.timestamp)}</span></div>
            </li>)}
          </ol> : <p className="live-security__empty">This list fills with real browser events. Clearing it does not delete your conversation.</p>}
          {liveEvents.length > 8 && <button className="live-security__text-button" type="button" onClick={() => setShowAll((current) => !current)} aria-expanded={showAll}>
            {showAll ? 'Show recent observations' : `Show all ${liveEvents.length} observations`} <ChevronDown size={14} aria-hidden="true" />
          </button>}
        </section>

        <aside className="live-security__observer" aria-label="Network observer view">
          <Eye size={23} aria-hidden="true" /><h3>What can an observer see?</h3>
          <p>On this LAN relay, a packet capture can show encrypted payloads, public keys, room and participant metadata, timing, and sizes.</p>
          <p><strong>The message text and secret chat keys are not sent in plaintext.</strong> A passive capture of these envelopes does not reveal their contents without the matching keys.</p>
          <p>Compare safety codes to check the peer keys. Encryption alone does not authenticate an unverified partner.</p>
          <span className="live-security__observer-note">This screen observes the app. It is not a network packet capture.</span>
        </aside>
      </div>

      <details className="live-security__technical">
        <summary>See technical details <ChevronDown size={15} aria-hidden="true" /></summary>
        <div>
          <p><strong>Key establishment:</strong> browser P-256 ECDH → HKDF-SHA-256 → separate directional AES-256-GCM keys. A fresh random IV is used for each encrypted message, with reuse checks.</p>
          <p><strong>Scope:</strong> the most recent 60 observations stay in this page’s memory. Times use this Mac’s clock; they are not cross-device latency measurements. History replay is excluded from this live view.</p>
          <p><strong>Media:</strong> this trace follows encrypted chat envelopes, including protected file descriptors and capability messages. Encrypted image/video data travels separately; these byte counts are not file-transfer progress.</p>
          <p><strong>Limits:</strong> a local decryption of your own relay echo does not prove remote delivery. Endpoint compromise can expose content. The current key design has no forward secrecy.</p>
        </div>
      </details>

      <aside className="live-security__lab-link">
        <FlaskConical size={24} aria-hidden="true" />
        <div><h3>Demonstrate eavesdropping separately</h3>
          <p>In the BB84 Security Lab, compare a clean run with Eve’s intercept-and-resend simulation. BB84 output is not connected to these chat keys; this is not physical quantum key distribution.</p></div>
        <button className="live-security__button" type="button" onClick={onOpenLab}>Open BB84 lab <ArrowRight size={15} aria-hidden="true" /></button>
      </aside>
    </section>
  );
}
