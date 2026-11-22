import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Atom,
  Check,
  CheckCheck,
  CircleAlert,
  Clipboard,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  Fingerprint,
  FlaskConical,
  Info,
  KeyRound,
  Laptop2,
  LoaderCircle,
  Lock,
  Menu,
  MessageCircle,
  Network,
  Paperclip,
  Play,
  Radio,
  RefreshCw,
  SendHorizontal,
  Server,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  WifiOff,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoomCode, getNetworkStatus, isLanInvitationCode, joinRoom, normalizeRoomCode } from './api';
import { BB84_QUBIT_COUNTS } from './bb84';
import { MAX_ENCRYPTED_PLAINTEXT_BYTES } from './e2ee';
import type {
  Bb84Config,
  Bb84PostProcessing,
  Bb84Result,
  Bb84RunState,
} from './bb84';
import { useChat } from './hooks/useChat';
import type { EndpointBb84Progress } from './bb84ChatSession';
import { EndpointBb84RuntimeSummary, LabParticipants, SecurityLabWalkthrough } from './SecurityLabWalkthrough';
import { getEndpointBb84RuntimeStatus } from './bb84RuntimeStatus';
import { PresentationDialog } from './PresentationDialog';
import { CafeWelcome } from './CafeWelcome';
import { EavesdroppingDemo } from './EavesdroppingDemo';
import { AttachmentMessage } from './AttachmentMessage';
import { isMediaControl, useMediaCapability } from './useMediaCapability';
import { ATTACHMENT_ACCEPT, isAttachmentMessage, prepareAttachment, validateAttachmentFile } from './attachments';
import './chat-media.css';
import type {
  ChatMessage,
  ChatSession,
  ConnectionInfo,
  EncryptionInfo,
  JoinRoomResult,
  NetworkStatus,
  Participant,
  RoomSnapshot,
} from './types';
import { MAX_MESSAGE_LENGTH } from './types';

const EMPTY_SNAPSHOT: RoomSnapshot = { messages: [], participants: [] };
const NAME_STORAGE_KEY = 'bb84-chat-display-name';
const ROOM_STORAGE_KEY = 'bb84-chat-room-code';
const UTF8_ENCODER = new TextEncoder();

function loadPreference(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function savePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience only. The chat works when it is unavailable.
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function dateTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function percentageLabel(value: number): string {
  const rounded = Math.round(value * 100 * 10_000) / 10_000;
  return `${rounded}%`;
}

function sameCalendarDay(left: string, right: string): boolean {
  const first = new Date(left);
  const second = new Date(right);
  return !Number.isNaN(first.getTime())
    && !Number.isNaN(second.getTime())
    && first.toDateString() === second.toDateString();
}

interface OnboardingProps {
  onJoin: (input: {
    displayName: string;
    roomCode: string;
    mode: 'create' | 'join';
  }, networkStatus: NetworkStatus | null) => Promise<void>;
}

type NetworkCheckState = 'checking' | 'ready' | 'local' | 'unavailable';

interface NetworkReadinessProps {
  mode: 'create' | 'join';
  status: NetworkStatus | null;
  state: NetworkCheckState;
}

function NetworkReadiness({ mode, status, state }: NetworkReadinessProps) {
  if (status?.mode === 'hosted') {
    return (
      <aside className="network-readiness network-readiness--ready" role="status" aria-live="polite">
        <Server size={18} aria-hidden="true" />
        <div>
          <strong>Online room server</strong>
          <p>Open this same website on both devices, then share the room code.</p>
        </div>
      </aside>
    );
  }
  if (mode === 'join' && state !== 'checking' && state !== 'unavailable') {
    return (
      <aside className="network-readiness network-readiness--info" aria-label="Joining across Macs">
        <Network size={18} aria-hidden="true" />
        <div>
          <strong>Joining from another Mac?</strong>
          <p>Paste the complete LAN room code. This app will use it to reach the room host through your local server.</p>
        </div>
      </aside>
    );
  }

  const content = {
    checking: {
      title: 'Checking connection',
      copy: 'Checking how this server connects your room.',
    },
    ready: {
      title: 'LAN invitations ready',
      copy: `New room codes will route your partner to this Mac at ${status?.advertisedHost}.`,
    },
    local: {
      title: 'Local rooms only',
      copy: 'This Mac has no shareable private address. Connect both Macs to the same regular Wi-Fi and restart LAN mode.',
    },
    unavailable: {
      title: 'Network status unavailable',
      copy: 'Check the connection and retry before creating or joining a room.',
    },
  }[state];

  return (
    <aside
      className={`network-readiness network-readiness--${state}`}
      role="status"
      aria-live="polite"
    >
      {state === 'checking'
        ? <LoaderCircle className="spin" size={18} aria-hidden="true" />
        : state === 'ready'
          ? <Network size={18} aria-hidden="true" />
          : <WifiOff size={18} aria-hidden="true" />}
      <div>
        <strong>{content.title}</strong>
        <p>{content.copy}</p>
      </div>
    </aside>
  );
}

function Onboarding({ onJoin }: OnboardingProps) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const modeRef = useRef<'create' | 'join'>('create');
  const [displayName, setDisplayName] = useState(() => loadPreference(NAME_STORAGE_KEY));
  const [roomCode, setRoomCode] = useState('');
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null);
  const [networkCheck, setNetworkCheck] = useState<NetworkCheckState>('checking');
  const [networkAttempt, setNetworkAttempt] = useState(0);
  const [error, setError] = useState('');
  const [invalidField, setInvalidField] = useState<'name' | 'room' | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const roomInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);

  const generateCode = useCallback((status: NetworkStatus | null) => {
    if (!status) {
      setRoomCode('');
      return;
    }
    try {
      setRoomCode(createRoomCode(status?.ready ? status.advertisedHost : null, status?.mode));
      setError('');
      setInvalidField(null);
    } catch (generationError) {
      setRoomCode('');
      setError(generationError instanceof Error ? generationError.message : 'Could not generate a secure room code.');
      setInvalidField('room');
    }
  }, []);

  useEffect(() => {
    let active = true;
    getNetworkStatus()
      .then((status) => {
        if (!active) return;
        setNetworkStatus(status);
        setNetworkCheck(status.ready ? 'ready' : 'local');
        if (modeRef.current === 'create') {
          generateCode(status);
        }
      })
      .catch(() => {
        if (!active) return;
        setNetworkStatus(null);
        setNetworkCheck('unavailable');
        if (modeRef.current === 'create') setRoomCode('');
      });
    return () => {
      active = false;
    };
  }, [generateCode, networkAttempt]);

  const retryNetworkCheck = () => {
    setNetworkStatus(null);
    setNetworkCheck('checking');
    if (modeRef.current === 'create') setRoomCode('');
    setNetworkAttempt(attempt => attempt + 1);
  };

  const changeMode = (nextMode: 'create' | 'join') => {
    modeRef.current = nextMode;
    setMode(nextMode);
    setError('');
    setInvalidField(null);
    if (nextMode === 'create') generateCode(networkStatus);
    else setRoomCode(loadPreference(ROOM_STORAGE_KEY));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!networkStatus || networkCheck === 'checking') return;
    const cleanName = displayName.trim();
    const cleanRoom = normalizeRoomCode(roomCode);
    if (cleanName.length < 2) {
      setError('Enter a name with at least 2 characters.');
      setInvalidField('name');
      nameInputRef.current?.focus();
      return;
    }
    if (cleanName.length > 24) {
      setError('Keep your name to 24 characters or fewer.');
      setInvalidField('name');
      nameInputRef.current?.focus();
      return;
    }
    if (!/^[A-Z0-9][A-Z0-9-]{3,63}$/.test(cleanRoom)) {
      setError('Use 4–64 letters, numbers, or hyphens, starting with a letter or number.');
      setInvalidField('room');
      roomInputRef.current?.focus();
      return;
    }
    if (networkStatus?.mode === 'hosted' && isLanInvitationCode(cleanRoom)) {
      setError('This code belongs to a private LAN room. Create a new room on this website and share its code.');
      setInvalidField('room');
      roomInputRef.current?.focus();
      return;
    }
    setError('');
    setInvalidField(null);
    setSubmitting(true);
    try {
      await onJoin({ displayName: cleanName, roomCode: cleanRoom, mode }, networkStatus);
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Could not open the room.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CafeWelcome>
        <div className="onboarding-card">
          <div className="onboarding-card__header">
            <h2 id="join-title">Open a room</h2>
            <p>Use a name your partner will recognize. Your encryption key is created on this device.</p>
          </div>

          <div className="mode-switch" role="group" aria-label="Room action">
            <button
              type="button"
              className={mode === 'create' ? 'is-active' : ''}
              aria-pressed={mode === 'create'}
              onClick={() => changeMode('create')}
            >
              Create room
            </button>
            <button
              type="button"
              className={mode === 'join' ? 'is-active' : ''}
              aria-pressed={mode === 'join'}
              onClick={() => changeMode('join')}
            >
              Join room
            </button>
          </div>

          <NetworkReadiness mode={mode} status={networkStatus} state={networkCheck} />
          {networkCheck === 'unavailable' && (
            <button className="security-secondary" type="button" onClick={retryNetworkCheck}>
              Retry connection check
            </button>
          )}

          <form className="onboarding-form" onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="display-name">Your name</label>
              <span className="field__control">
                <UserRound size={18} aria-hidden="true" />
                <input
                  id="display-name"
                  ref={nameInputRef}
                  aria-invalid={invalidField === 'name' || undefined}
                  aria-describedby={invalidField === 'name' ? 'join-error' : undefined}
                  autoFocus
                  name="displayName"
                  autoComplete="name"
                  maxLength={24}
                  placeholder="e.g. Alice"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  disabled={submitting}
                />
              </span>
            </div>

            <div className="field">
              <label htmlFor="room-code">{mode === 'create' ? 'Your new room code' : 'Room code'}</label>
              <span className="field__control field__control--code">
                <span className="code-prefix" aria-hidden="true">#</span>
                <input
                  id="room-code"
                  ref={roomInputRef}
                  aria-invalid={invalidField === 'room' || undefined}
                  aria-describedby={invalidField === 'room' ? 'join-error' : undefined}
                  name="roomCode"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="text"
                  maxLength={64}
                  placeholder="QKD-ABC123"
                  value={roomCode}
                  readOnly={mode === 'create'}
                  onChange={(event) => setRoomCode(normalizeRoomCode(event.target.value))}
                  disabled={submitting}
                />
                {mode === 'create' && (
                  <button
                    type="button"
                    className="field__action"
                    aria-label="Generate another room code"
                    title="Generate another code"
                    onClick={() => generateCode(networkStatus)}
                    disabled={submitting || !networkStatus || networkCheck === 'checking'}
                  >
                    <RefreshCw size={17} />
                  </button>
                )}
              </span>
            </div>

            {error && (
              <div className="inline-error" id="join-error" role="alert">
                <CircleAlert size={17} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <button
              className="primary-button"
              type="submit"
              disabled={submitting || !networkStatus || networkCheck === 'checking'}
            >
              {networkCheck === 'checking' ? (
                <><LoaderCircle className="spin" size={19} /> Checking connection…</>
              ) : submitting ? (
                <><LoaderCircle className="spin" size={19} /> Opening room…</>
              ) : (
                <>{mode === 'create' ? 'Create and enter' : 'Join conversation'} <ArrowRight size={19} /></>
              )}
            </button>
          </form>

          <aside className="honesty-note" aria-label="Encryption information">
            <ShieldCheck size={19} aria-hidden="true" />
            <div>
              <strong>Encryption starts inside the room</strong>
              <p>Sending stays paused until both browsers exchange public keys. The room-hosted BB84 teaching run is separate; endpoint-owned BB84 can contribute to chat keys after confirmation.</p>
            </div>
          </aside>
        </div>
    </CafeWelcome>
  );
}

interface ConnectionBadgeProps {
  connection: ConnectionInfo;
}

function ConnectionBadge({ connection }: ConnectionBadgeProps) {
  const content = {
    idle: { label: 'Not connected', icon: WifiOff },
    connecting: { label: 'Connecting', icon: LoaderCircle },
    connected: { label: 'Live', icon: Radio },
    reconnecting: { label: 'Reconnecting', icon: RefreshCw },
    offline: { label: 'Offline', icon: WifiOff },
    error: { label: 'Needs attention', icon: AlertCircle },
  }[connection.state];
  const Icon = content.icon;
  return (
    <span className={`connection-badge connection-badge--${connection.state}`}>
      <Icon
        size={14}
        aria-hidden="true"
        className={['connecting', 'reconnecting'].includes(connection.state) ? 'spin' : ''}
      />
      <span>{content.label}</span>
    </span>
  );
}

function shortFingerprint(value: string | null): string {
  if (!value) return 'Not available';
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function encryptionCopy(encryption: EncryptionInfo) {
  return {
    idle: { label: 'Encryption pending', detail: 'Waiting to begin.', icon: LoaderCircle },
    setting_up: { label: 'Setting up encryption', detail: 'Creating and advertising this browser key.', icon: LoaderCircle },
    waiting_for_peer: { label: 'Waiting for partner key', detail: 'Sending is paused until both browsers are ready.', icon: KeyRound },
    encrypted_unverified: { label: 'Encrypted · Unverified', detail: 'Contents are encrypted, but the partner device is not verified yet.', icon: Lock },
    encrypted_verified: { label: 'Encrypted · Verified on this browser', detail: 'The current two device keys were compared on this browser.', icon: ShieldCheck },
    key_changed: { label: 'Device key changed', detail: 'Sending is paused until you review the new safety code.', icon: ShieldAlert },
    failed: { label: 'Encryption failed', detail: encryption.error || 'The encrypted session needs attention.', icon: AlertCircle },
  }[encryption.state];
}

interface EncryptionBadgeProps {
  encryption: EncryptionInfo;
  onOpen: () => void;
}

function EncryptionBadge({ encryption, onOpen }: EncryptionBadgeProps) {
  const content = encryptionCopy(encryption);
  const Icon = content.icon;
  return (
    <button
      type="button"
      className={`encryption-badge encryption-badge--${encryption.state}`}
      onClick={onOpen}
      aria-label={`${content.label}. Open encryption details`}
    >
      <Icon
        size={15}
        aria-hidden="true"
        className={['idle', 'setting_up'].includes(encryption.state) ? 'spin' : ''}
      />
      <span>{content.label}</span>
    </button>
  );
}

export interface SecurityPanelProps {
  open: boolean;
  encryption: EncryptionInfo;
  endpointBb84: EndpointBb84Progress;
  onClose: () => void;
  onVerify: () => void;
  onClearVerification: () => void;
  onAcceptChangedKey: () => void;
  onRetry: () => void;
}

export function SecurityPanel({
  open,
  encryption,
  endpointBb84,
  onClose,
  onVerify,
  onClearVerification,
  onAcceptChangedKey,
  onRetry,
}: SecurityPanelProps) {
  const [comparisonConfirmed, setComparisonConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const content = encryptionCopy(encryption);
  const Icon = content.icon;
  const runtimeStatus = getEndpointBb84RuntimeStatus(encryption, endpointBb84);
  const hybridActive = runtimeStatus.chatMode === 'BB84-ECDH hybrid active';

  useEffect(() => {
    if (!open) return undefined;
    const returnFocusTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setComparisonConfirmed(false);
    setCopied(false);

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    closeButtonRef.current?.focus();
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      returnFocusTarget?.focus();
    };
  }, [open, encryption.sessionKeyId, onClose]);

  if (!open) return null;

  const sessionReady = Boolean(encryption.sessionKeyId);
  const verified = encryption.state === 'encrypted_verified';
  const canCompare = Boolean(encryption.verificationCode)
    && ['encrypted_unverified', 'key_changed'].includes(encryption.state);

  const copyCode = async () => {
    if (!encryption.verificationCode) return;
    try {
      await navigator.clipboard.writeText(encryption.verificationCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="security-layer" role="presentation">
      <button className="security-backdrop" type="button" aria-label="Close encryption details" onClick={onClose} />
      <section
        ref={panelRef}
        className="security-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-title"
      >
        <header className="security-panel__header">
          <div>
            <span>Message encryption</span>
            <h2 id="security-title">Security details</h2>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="Close encryption details" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <section className={`security-overview security-overview--${encryption.state}`} role="status" aria-label="Current chat security">
          <div className="security-overview__connection">
            <Icon
              size={19}
              aria-hidden="true"
              className={['idle', 'setting_up'].includes(encryption.state) ? 'spin' : ''}
            />
            <div><strong>{content.label}</strong><p>{content.detail}</p></div>
          </div>
          <div className="security-overview__mode">
            <span>Active message encryption</span>
            <strong>{runtimeStatus.chatMode === 'BB84-ECDH hybrid active' ? 'BB84 + ECDH Hybrid' : runtimeStatus.chatMode === 'ECDH-only' ? 'ECDH-only' : 'Not ready'}</strong>
          </div>
          <div className="security-overview__indicators">
            <span>BB84 contribution <b>{runtimeStatus.contribution === 'Confirmed' && runtimeStatus.contributionInChat !== 'Active in hybrid epoch' ? 'Confirmed · inactive' : runtimeStatus.contribution}</b></span>
            <span>Key confirmation <b>{runtimeStatus.keyConfirmation}</b></span>
            <span>Message cipher <b>AES-256-GCM</b></span>
          </div>
        </section>

        {encryption.error && encryption.state !== 'failed' && (
          <p className="security-warning"><AlertCircle size={16} />{encryption.error}</p>
        )}

        {encryption.verificationCode && (
          <section className="safety-code" aria-labelledby="safety-code-title">
            <div className="security-section-heading">
              <div>
                <span>Peer verification</span>
                <h3 id="safety-code-title">Compare this safety code</h3>
              </div>
              <button type="button" onClick={copyCode}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <output aria-label="Safety code">{encryption.verificationCode}</output>
            <p>
              Compare every digit with {encryption.peerName || 'your partner'} in person or on a
              different trusted call. Do not paste it into this chat.
            </p>

            {canCompare && (
              <>
                <label className="verification-check">
                  <input
                    type="checkbox"
                    checked={comparisonConfirmed}
                    onChange={(event) => setComparisonConfirmed(event.target.checked)}
                  />
                  <span>I compared the full code through a different trusted channel.</span>
                </label>
                <button
                  className="security-primary"
                  type="button"
                  disabled={!comparisonConfirmed}
                  onClick={() => {
                    onVerify();
                    setComparisonConfirmed(false);
                  }}
                >
                  <ShieldCheck size={17} /> Codes match
                </button>
                {encryption.state === 'key_changed' && (
                  <button className="security-secondary" type="button" onClick={onAcceptChangedKey}>
                    Accept new key, keep unverified
                  </button>
                )}
              </>
            )}

            {verified && (
              <div className="verification-record">
                <ShieldCheck size={17} />
                <div>
                  <strong>Verified on this browser</strong>
                  <span>{encryption.verifiedAt ? `Recorded ${dateTimeLabel(encryption.verifiedAt)}` : 'Current device keys matched'}</span>
                </div>
                <button type="button" onClick={onClearVerification}>Clear</button>
              </div>
            )}
          </section>
        )}

        <details className="technical-details">
          <summary><Info size={16} /> Technical details</summary>
          <section className="encryption-flow" aria-labelledby="encryption-flow-title">
          <div className="security-section-heading">
            <div><h3 id="encryption-flow-title">Key and message details</h3></div>
          </div>
          <EndpointBb84RuntimeSummary encryption={encryption} endpointBb84={endpointBb84} />
          <p className="technical-details__flow"><strong>Key derivation:</strong> {hybridActive
            ? 'ECDH shared secret + confirmed BB84 contribution → HKDF-SHA-256 → separate directional AES-256-GCM keys.'
            : 'ECDH shared secret → HKDF-SHA-256 → separate directional AES-256-GCM keys.'}</p>
          <ol>
            <li className={encryption.localKeyId ? 'is-complete' : ''}>
              <span><KeyRound size={17} /></span>
              <div><strong>Created in this browser</strong><p>A non-extractable P-256 private key remains on this device.</p></div>
              <small>{encryption.localKeyId ? 'Ready' : 'Pending'}</small>
            </li>
            <li className={sessionReady ? 'is-complete' : ''}>
              <span><Fingerprint size={17} /></span>
              <div><strong>Paired with your partner</strong><p>ECDH combines this browser’s private key with the partner’s public key to establish a shared secret.</p></div>
              <small>{sessionReady ? 'Established' : 'Pending'}</small>
            </li>
            {hybridActive && <>
              <li className="is-complete">
                <span><KeyRound size={17} /></span>
                <div><strong>BB84 contribution</strong><p>Both browsers simulate the exchange independently; matching material contributes after reconciliation, privacy amplification and mutual confirmation.</p></div>
                <small>Used in hybrid mode</small>
              </li>
            </>}
            <li className={sessionReady ? 'is-complete' : ''}>
              <span><KeyRound size={17} /></span>
              <div><strong>Separated by direction</strong><p>{hybridActive
                ? 'HKDF-SHA-256 combines the ECDH shared secret and confirmed BB84 contribution to derive separate sending and receiving keys.'
                : 'HKDF-SHA-256 derives separate sending and receiving keys from the ECDH shared secret.'}</p></div>
              <small>{sessionReady ? 'Derived' : 'Pending'}</small>
            </li>
            <li className={sessionReady ? 'is-complete' : ''}>
              <span><Lock size={17} /></span>
              <div><strong>Sealed before sending</strong><p>AES-256-GCM encrypts and authenticates the message before WebSocket transmission.</p></div>
              <small>{sessionReady ? 'Active' : 'Pending'}</small>
            </li>
            <li className={sessionReady ? 'is-complete' : ''}>
              <span><Server size={17} /></span>
              <div><strong>Relayed as ciphertext</strong><p>The server receives public metadata and an encrypted envelope, not readable message text.</p></div>
              <small>{sessionReady ? 'Ciphertext' : 'Pending'}</small>
            </li>
          </ol>
          </section>
          <dl>
            <div><dt>Your public-key fingerprint</dt><dd><code>{shortFingerprint(encryption.localKeyId)}</code></dd></div>
            <div><dt>Partner public-key fingerprint</dt><dd><code>{shortFingerprint(encryption.peerKeyId)}</code></dd></div>
            <div><dt>Pair key ID</dt><dd><code>{shortFingerprint(encryption.sessionKeyId)}</code></dd></div>
            <div><dt>Private-key storage</dt><dd>{encryption.keyStorage === 'device' ? 'Browser IndexedDB' : encryption.keyStorage === 'session' ? 'Page memory fallback' : 'Not ready'}</dd></div>
            <div><dt>Message cipher</dt><dd>AES-256-GCM, random 96-bit IV with reuse checks</dd></div>
          </dl>
        </details>

        <aside className="metadata-note">
          <EyeOff size={17} />
          <p><strong>Against an honest relay, message text is ciphertext.</strong> Until you compare the safety code, an active relay could substitute browser keys. Room, names, timing, presence, and size remain visible. Verification confirms device keys, not a legal identity.</p>
        </aside>

        {encryption.state === 'failed' && (
          <button className="security-primary" type="button" onClick={onRetry}>
            <RefreshCw size={17} /> Retry encryption
          </button>
        )}
      </section>
    </div>
  );
}

interface ParticipantListProps {
  participants: Participant[];
  currentClientId: string;
}

function ParticipantList({ participants, currentClientId }: ParticipantListProps) {
  const visibleParticipants = participants.slice(0, 2);
  return (
    <div className="participants-section">
      <div className="section-heading">
        <span>In this room</span>
        <span>{visibleParticipants.filter((participant) => participant.online).length}/2</span>
      </div>
      <ul className="participant-list">
        {visibleParticipants.map((participant) => (
          <li key={participant.id}>
            <span className="avatar avatar--small" aria-hidden="true">
              {initials(participant.name)}
              <span className={`presence-dot${participant.online ? ' is-online' : ''}`} />
            </span>
            <span className="participant-copy">
              <strong>{participant.name}{participant.id === currentClientId ? ' (you)' : ''}</strong>
              <span>{participant.online ? 'Online now' : 'Disconnected'}</span>
            </span>
          </li>
        ))}
        {visibleParticipants.length < 2 && (
          <li className="waiting-participant">
            <span className="avatar avatar--small avatar--empty" aria-hidden="true"><UsersRound size={16} /></span>
            <span className="participant-copy">
              <strong>Waiting for someone</strong>
              <span>Share the room code</span>
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

interface ChatSidebarProps {
  open: boolean;
  session: ChatSession;
  networkStatus: NetworkStatus | null;
  participants: Participant[];
  connection: ConnectionInfo;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
  onLeave: () => void;
}

function ChatSidebar({
  open,
  session,
  networkStatus,
  participants,
  connection,
  copied,
  onCopy,
  onClose,
  onLeave,
}: ChatSidebarProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  return (
    <>
      <button
        className={`sidebar-backdrop${open ? ' is-visible' : ''}`}
        type="button"
        aria-label="Close room details"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside id="room-notes" className={`chat-sidebar cafe-room-notes${open ? ' is-open' : ''}`} aria-label="Room details"
        role={open ? 'dialog' : undefined} aria-modal={open || undefined}
        onKeyDown={event => {
          if (!open) return;
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          if (event.key === 'Tab') {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'));
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <div className="cafe-room-notes__heading">
          <div><span>Shared space</span><h2>Room notes</h2></div>
          <button ref={closeRef} className="icon-button sidebar-close" type="button" aria-label="Close room details" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <ParticipantList participants={participants} currentClientId={session.clientId} />

        <div className="room-card">
          <span className="room-card__eyebrow">Room invitation</span>
          <div className="room-card__code">
            <strong>{session.roomCode}</strong>
            <button className="copy-button" type="button" onClick={onCopy} aria-label="Copy room code">
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p>{networkStatus?.mode === 'hosted'
            ? 'Open this same website on both devices, then share the room code.'
            : session.roomRoute === 'host'
            ? 'Share the complete code. Your partner enters it in the app on their own Mac.'
            : session.roomRoute === 'partner'
              ? 'This invitation identifies the room host on your private network.'
              : 'Share this code with one person using this same server.'}</p>
          <RoomRouteCard session={session} connection={connection} networkStatus={networkStatus} />
        </div>

        <div className="sidebar-spacer" />

        <button className="leave-button" type="button" onClick={onLeave}>
          <ArrowLeft size={17} /> Leave room
        </button>
      </aside>
    </>
  );
}

interface RoomRouteCardProps {
  session: ChatSession;
  connection: ConnectionInfo;
  networkStatus: NetworkStatus | null;
}

function RoomRouteCard({ session, connection, networkStatus }: RoomRouteCardProps) {
  const isConnected = connection.state === 'connected';
  const hasError = connection.state === 'error' || connection.state === 'offline';
  if (networkStatus?.mode === 'hosted') {
    return (
      <aside className="room-route" aria-label="Room connection path">
        <Server size={17} aria-hidden="true" />
        <div>
          <strong>Online room server</strong>
          <span>Both devices connect to this website.</span>
        </div>
      </aside>
    );
  }
  if (session.roomRoute === 'host') {
    return (
      <aside className="room-route room-route--host" aria-label="Room connection path">
        <Laptop2 size={17} aria-hidden="true" />
        <div>
          <strong>This Mac hosts the room</strong>
          <span>Your invitation points to {session.roomHost ?? 'this private server'}.</span>
        </div>
      </aside>
    );
  }
  if (session.roomRoute === 'partner') {
    const title = hasError
      ? 'Room host unavailable'
      : isConnected
        ? 'Connected through this Mac to room host'
        : 'Connecting through this Mac to room host';
    return (
      <aside
        className={`room-route room-route--partner${hasError ? ' room-route--error' : ''}`}
        aria-label="Room connection path"
        role="status"
      >
        <Network size={17} aria-hidden="true" />
        <div>
          <strong>{title}</strong>
          <span>{session.roomHost ? `Private host ${session.roomHost}` : 'Private LAN invitation'}</span>
        </div>
      </aside>
    );
  }
  return (
    <aside className="room-route" aria-label="Room connection path">
      <Laptop2 size={17} aria-hidden="true" />
      <div>
        <strong>Local server room</strong>
        <span>Legacy codes work only through this server.</span>
      </div>
    </aside>
  );
}

interface MessageBubbleProps {
  roomId: string;
  message: ChatMessage;
  mine: boolean;
  grouped: boolean;
  onRetry: (id: string) => void;
}

function MessageBubble({ message, mine, grouped, onRetry, roomId }: MessageBubbleProps) {
  if (message.kind === 'system') {
    return <div className="system-message"><span>{message.text}</span></div>;
  }
  const encrypting = mine && message.status === 'sending' && !message.encryption;
  const encrypted = message.security === 'encrypted' && Boolean(message.encryption);
  return (
    <article className={`message-row${mine ? ' message-row--mine' : ''}${grouped ? ' is-grouped' : ''}`}>
      {!mine && !grouped && <span className="avatar" aria-hidden="true">{initials(message.senderName)}</span>}
      {!mine && grouped && <span className="avatar-spacer" aria-hidden="true" />}
      <div className="message-content">
        {!mine && !grouped && <span className="message-sender">{message.senderName}</span>}
        <div className={`message-bubble${message.security === 'unavailable' ? ' message-bubble--unavailable' : ''}${isAttachmentMessage(message.text) ? ' message-bubble--media' : ''}`}>
          {isAttachmentMessage(message.text)
            ? message.security === 'encrypted' && message.encryption
              ? <AttachmentMessage text={message.text} roomId={roomId} />
              : <p>{message.status === 'sending' ? 'Encrypting attachment…' : 'Attachment unavailable or not sent.'}</p>
            : <p>{message.text}</p>}
        </div>
        <div className="message-meta">
          <time dateTime={message.sentAt}>{timeLabel(message.sentAt)}</time>
          {encrypting && (
            <span><LoaderCircle className="spin" size={11} /> Encrypting</span>
          )}
          {encrypted && (
            <span className="message-security" title="End-to-end encrypted"><Lock size={11} /> Encrypted</span>
          )}
          {message.security === 'decrypting' && <span><LoaderCircle className="spin" size={11} /> Decrypting</span>}
          {message.security === 'legacy_plaintext' && <span className="message-legacy"><ShieldAlert size={11} /> Earlier plaintext</span>}
          {message.security === 'unavailable' && <span className="message-legacy"><AlertCircle size={11} /> Not authenticated</span>}
          {mine && message.status === 'sending' && message.encryption && <span><Clock3 size={12} /> Sending</span>}
          {mine && message.status === 'sent' && (
            <span title="Accepted by the server for encrypted relay. This does not confirm your partner decrypted it."
              aria-label="Accepted by the server for encrypted relay. This does not confirm your partner decrypted it.">
              <CheckCheck size={13} aria-hidden="true" /> Relayed
            </span>
          )}
          {mine && message.status === 'failed' && (
            <button type="button" onClick={() => onRetry(message.id)}>
              <AlertCircle size={12} /> Not sent · Retry
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

interface ConnectionNoticeProps {
  connection: ConnectionInfo;
  onReconnect: () => void;
}

function ConnectionNotice({ connection, onReconnect }: ConnectionNoticeProps) {
  if ((connection.state === 'connected' && !connection.error) || connection.state === 'idle') return null;
  const isWaiting = ['connecting', 'reconnecting'].includes(connection.state);
  const canReconnect = !isWaiting && connection.state !== 'connected';
  let message = connection.error || 'Opening the real-time connection…';
  if (connection.state === 'reconnecting' && connection.nextRetrySeconds !== null) {
    message = `Connection interrupted. Retrying in ${connection.nextRetrySeconds}s.`;
  }
  return (
    <div
      className={`connection-notice connection-notice--${connection.error ? 'error' : connection.state}`}
      role={connection.error ? 'alert' : 'status'}
      aria-live="polite"
    >
      {isWaiting ? <LoaderCircle className="spin" size={17} /> : connection.state === 'connected' ? <AlertCircle size={17} /> : <WifiOff size={17} />}
      <span>{message}</span>
      {canReconnect && (
        <button type="button" onClick={onReconnect}><RefreshCw size={14} /> Try again</button>
      )}
    </div>
  );
}

type Bb84PercentageKey = Exclude<keyof Bb84Config, 'qubitCount' | 'seed'>;

interface LabRangeProps {
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

function LabRange({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: LabRangeProps) {
  return (
    <label className="lab-control" htmlFor={id}>
      <span className="lab-control__heading">
        <strong>{label}</strong>
        <output htmlFor={id}>{value}%</output>
      </span>
      <span className="lab-control__description">{description}</span>
      <input
        id={id}
        aria-label={`${label} percentage`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
      <span className="lab-control__scale" aria-hidden="true"><span>{min}%</span><span>{max}%</span></span>
    </label>
  );
}

function bb84DecisionCopy(result: Bb84Result): { title: string; detail: string } {
  if (result.decision.status === 'accepted') {
    return {
      title: 'Below the demo threshold',
      detail: 'The disclosed sample stayed at or below the selected QBER limit.',
    };
  }
  if (result.decision.reason === 'insufficient_sifted_bits') {
    return {
      title: 'Experiment aborted',
      detail: 'Too few matching-basis measurements remained for a useful sample.',
    };
  }
  return {
    title: 'Experiment aborted',
    detail: 'The disclosed sample exceeded the selected QBER limit.',
  };
}

type ProcessingStageState = 'completed' | 'failed' | 'skipped';

interface ProcessingMetric {
  label: string;
  value: string | number;
  help: string;
}

function processingOutcomeCopy(processing: Bb84PostProcessing): {
  title: string;
  detail: string;
} {
  if (processing.status === 'completed') {
    return {
      title: 'Post-processing model completed',
      detail: 'All four teaching stages ran. Temporary output was discarded and did not supply or change the live chat keys. HKDF expansion does not add entropy or security strength.',
    };
  }
  if (processing.reason === 'bb84_not_accepted') {
    return {
      title: 'Post-processing was not started',
      detail: 'The BB84 sample did not pass, so every later teaching step was safely skipped.',
    };
  }
  if (processing.reason === 'reconciliation_failed') {
    return {
      title: 'Reconciliation could not be verified',
      detail: 'The model could not resolve the remaining disagreements, so it stopped before deriving anything.',
    };
  }
  if (processing.reason === 'insufficient_entropy') {
    return {
      title: 'Not enough estimated secret information',
      detail: 'After errors, disclosed information and the safety margin, too little remained. Try a larger or cleaner run; HKDF cannot create missing entropy.',
    };
  }
  if (processing.reason === 'confirmation_failed') {
    return {
      title: 'Internal confirmation check failed',
      detail: 'A defensive consistency check did not match. Temporary material was discarded.',
    };
  }
  return {
    title: 'Internal derivation check failed',
    detail: 'Confirmation passed, but the derived values did not match. Temporary material was discarded.',
  };
}

function processingStageStates(processing: Bb84PostProcessing): ProcessingStageState[] {
  if (processing.status === 'completed') return ['completed', 'completed', 'completed', 'completed'];
  if (processing.status === 'skipped') return ['skipped', 'skipped', 'skipped', 'skipped'];
  if (processing.reason === 'reconciliation_failed') return ['failed', 'skipped', 'skipped', 'skipped'];
  if (processing.reason === 'insufficient_entropy') return ['completed', 'failed', 'skipped', 'skipped'];
  if (processing.reason === 'confirmation_failed') return ['completed', 'completed', 'failed', 'skipped'];
  return ['completed', 'completed', 'completed', 'failed'];
}

function PostProcessingPanel({ result }: { result: Bb84Result }) {
  const processing = result.postProcessing;
  const outcome = processingOutcomeCopy(processing);
  const stageStates = processingStageStates(processing);
  const stageLabels = ['Reconcile', 'Reduce exposure', 'Confirm', 'Derive'];
  const stageDescriptions = [
    'Correct disagreements and count the parity information disclosed.',
    'Estimate what may remain private, subtract a margin, then compress.',
    'Compare a modeled tag to check that both simulated sides agree.',
    'Create context-bound output, then discard it; chat never receives it.',
  ];
  const cards: Array<{
    title: string;
    eyebrow: string;
    algorithm: string;
    metrics: ProcessingMetric[];
  }> = [
    {
      eyebrow: 'Step 1',
      title: 'Reconcile disagreements',
      algorithm: processing.reconciliation.algorithm,
      metrics: [
        { label: 'Input', value: `${processing.inputBits} bits`, help: 'Candidate bits left after the disclosed QBER sample was removed.' },
        { label: 'Passes', value: processing.reconciliation.passes, help: 'Modeled rounds used to locate disagreements.' },
        { label: 'Corrected', value: processing.reconciliation.correctedErrors, help: 'Modeled disagreements corrected during reconciliation.' },
        { label: 'Remaining', value: processing.reconciliation.remainingErrors, help: 'Disagreements still present after the modeled passes.' },
        { label: 'Disclosed', value: `${processing.reconciliation.leakedBits} bits`, help: 'Information treated as exposed during reconciliation.' },
        { label: 'Verified', value: processing.reconciliation.verified ? 'Yes' : 'No', help: 'Whether the reconciliation model ended with matching candidate material.' },
      ],
    },
    {
      eyebrow: 'Step 2',
      title: 'Reduce exposure',
      algorithm: processing.privacyAmplification.algorithm,
      metrics: [
        { label: 'Entropy model', value: processing.privacyAmplification.entropyModel, help: 'An illustrative asymptotic BB84 estimate for teaching. It is not a finite-key security proof.' },
        { label: 'Estimate', value: `${processing.privacyAmplification.estimatedSecretBits} bits`, help: 'Illustrative asymptotic estimate after QBER and disclosed leakage are considered.' },
        { label: 'Safety margin', value: `${processing.privacyAmplification.securityMarginBits} bits`, help: 'Extra bits removed to make this teaching estimate conservative.' },
        { label: 'Compressed to', value: `${processing.privacyAmplification.outputBits} bits`, help: 'Length of the temporary modeled output after exposure reduction.' },
      ],
    },
    {
      eyebrow: 'Step 3',
      title: 'Confirm agreement',
      algorithm: processing.confirmation.algorithm,
      metrics: [
        { label: 'Check tag', value: `${processing.confirmation.tagBits} bits`, help: 'Length of the modeled comparison tag. The tag is not a chat key.' },
        { label: 'Passed', value: processing.confirmation.passed ? 'Yes' : 'No', help: 'Whether both simulated sides produced the same confirmation result.' },
      ],
    },
    {
      eyebrow: 'Step 4',
      title: 'Derive and discard',
      algorithm: processing.derivation.algorithm,
      metrics: [
        { label: 'Output length', value: `${processing.derivation.outputBits} bits`, help: 'HKDF can format 128 input bits as a 256-bit-sized value, but it cannot create more entropy or more than 128 bits of modeled strength.' },
        { label: 'Context bound', value: processing.derivation.contextBound ? 'Yes' : 'No', help: 'Whether the derivation model included this room and simulation context.' },
        { label: 'Material retained', value: processing.derivation.materialRetained ? 'Yes' : 'No', help: 'Temporary material must be discarded after aggregate metrics are recorded.' },
      ],
    },
  ];

  return (
    <section
      className={`post-processing post-processing--${processing.status}`}
      aria-labelledby="post-processing-title"
    >
      <div className="post-processing__heading">
        <div>
          <span className="eyebrow">Phase 3 · server-internal teaching model</span>
          <h3 id="post-processing-title">From accepted sample to discarded material</h3>
          <p>These are aggregate results from a classical calculation on the trusted creator backend. The entropy estimate is illustrative and asymptotic, not a finite-key security proof.</p>
        </div>
        <span className={`post-processing__status post-processing__status--${processing.status}`}>
          {processing.status === 'completed' ? <Check size={14} /> : processing.status === 'failed' ? <X size={14} /> : <ShieldAlert size={14} />}
          {processing.status}
        </span>
      </div>

      <aside
        className="post-processing__outcome"
        role={processing.status === 'failed' ? 'alert' : 'status'}
        aria-atomic="true"
      >
        <span aria-hidden="true">
          {processing.status === 'completed' ? <Check size={21} /> : <ShieldAlert size={21} />}
        </span>
        <div>
          <strong>{outcome.title}</strong>
          <p>{outcome.detail}</p>
          <span className="post-processing__chat-state"><b>Room-hosted report: Independent teaching simulation</b> · It does not set chat keys; endpoint-owned BB84 may establish the active hybrid epoch after confirmation.</span>
        </div>
      </aside>

      <ol className="processing-stages" aria-label="Educational post-processing stages">
        {stageLabels.map((label, index) => (
          <li className={`processing-stage processing-stage--${stageStates[index]}`} key={label}>
            <span className="processing-stage__number" aria-hidden="true">
              {stageStates[index] === 'completed' ? <Check size={13} /> : stageStates[index] === 'failed' ? <X size={13} /> : index + 1}
            </span>
            <span>
              <strong>{label}</strong>
              <small>{stageStates[index] === 'completed' ? 'Completed' : stageStates[index] === 'failed' ? 'Stopped here' : 'Not run'}</small>
              <span className="processing-stage__description">{stageDescriptions[index]}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="processing-cards">
        {cards.map((card, index) => (
          <article className={`processing-card processing-card--${stageStates[index]}`} key={card.title}>
            <header>
              <span>{card.eyebrow}</span>
              <h4>{card.title}</h4>
              <code>{card.algorithm}</code>
            </header>
            <dl>
              {card.metrics.map((metric) => (
                <div key={metric.label}>
                  <dt>{metric.label}</dt>
                  <dd>{metric.value}</dd>
                </div>
              ))}
            </dl>
            <details className="processing-card__help">
              <summary>Explain these metrics</summary>
              <ul>
                {card.metrics.map((metric) => (
                  <li key={metric.label}><strong>{metric.label}:</strong> {metric.help}</li>
                ))}
              </ul>
            </details>
          </article>
        ))}
      </div>

      <div className="processing-guardrails" role="note" aria-label="Post-processing safety boundary">
        <KeyRound size={18} aria-hidden="true" />
        <div>
          <strong>Temporary material is not directly serialized or retained</strong>
          <p>Serialized to clients: <b>{processing.keyMaterialExposed ? 'Yes' : 'No'}</b> · This room-hosted report does not set chat keys; the separate endpoint-owned browser exchange can establish a hybrid chat epoch after confirmation. · Retained by processor: <b>{processing.derivation.materialRetained ? 'Yes' : 'No'}</b></p>
          <span>HKDF may expand a 128-bit-sized intermediate value to 256 bits, but it cannot create entropy or raise its modeled strength above 128 bits.</span>
          <span>{processing.reproducibleTeachingRun
            ? 'This seeded teaching run is predictable: its internal values can be reconstructed from the shared seed, settings, room and session context. It provides no secrecy or cryptographic randomness.'
            : 'This was an unseeded teaching run. It is still a classical simulation, not physical QKD.'}</span>
        </div>
      </div>

      <aside className="encryption-roadmap" aria-label="Live message encryption">
        <span>Live chat</span>
        <div>
          <strong>This room-hosted report does not set the chat key</strong>
          <p>The room-hosted teaching simulation's output is discarded. The endpoint-owned browser exchange may establish the active hybrid chat key after confirmation; its live status is shown above and in Security Details.</p>
        </div>
      </aside>
    </section>
  );
}

export interface ProtocolLabProps {
  open: boolean;
  encryption: EncryptionInfo;
  connection: ConnectionInfo;
  participants: Participant[];
  currentClientId: string;
  result: Bb84Result | null;
  state: Bb84RunState;
  error: string | null;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onRun: (config: Bb84Config) => boolean;
  endpointBb84: EndpointBb84Progress;
  onStartEndpointBb84: (config: Bb84Config) => boolean;
  onUseEcdhFallback: () => void;
  onClose: () => void;
}

const endpointBb84Steps = [
  'State Preparation',
  'Measurement',
  'Basis Reconciliation',
  'QBER Analysis',
  'Error Correction',
  'Privacy Amplification',
  'Key Confirmation',
] as const;

const endpointBb84StageByStatus: Partial<Record<EndpointBb84Progress['status'], number>> = {
  preparing: 0,
  exchanging: 1,
  sifting: 2,
  sampling: 3,
  reconciling: 4,
  privacy_amplification: 5,
  key_confirmation: 6,
};

function endpointBb84StepState(status: EndpointBb84Progress['status'], index: number): 'complete' | 'current' | 'upcoming' {
  if (status === 'complete' || ((endpointBb84StageByStatus[status] ?? -1) > index)) return 'complete';
  if (endpointBb84StageByStatus[status] === index) return 'current';
  return 'upcoming';
}

export function ProtocolLab({
  open,
  encryption,
  connection,
  participants,
  currentClientId,
  result,
  state,
  error,
  returnFocusRef,
  onRun,
  endpointBb84,
  onStartEndpointBb84,
  onUseEcdhFallback,
  onClose,
}: ProtocolLabProps) {
  const [config, setConfig] = useState<Bb84Config>({
    qubitCount: 512,
    noiseProbability: 0,
    interceptProbability: 0,
    sampleRatio: 0.25,
    qberThreshold: 0.11,
    seed: null,
  });
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const returnFocusTarget = returnFocusRef.current;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => {
        // Closed disclosures must not become invisible keyboard-trap targets.
        let parent = element.parentElement;
        while (parent && parent !== dialogRef.current) {
          if (parent instanceof HTMLDetailsElement && !parent.open
            && element !== parent.querySelector(':scope > summary')) return false;
          parent = parent.parentElement;
        }
        return true;
      });
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    closeButtonRef.current?.focus();
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      returnFocusTarget?.focus();
    };
  }, [onClose, open, returnFocusRef]);

  if (!open) return null;

  const updatePercentage = (key: Bb84PercentageKey, percentage: number) => {
    setConfig((current) => ({ ...current, [key]: percentage / 100 }));
  };
  const running = state === 'running';
  const connected = connection.state === 'connected';
  const endpointRuntime = getEndpointBb84RuntimeStatus(encryption, endpointBb84);
  const decisionCopy = result ? bb84DecisionCopy(result) : null;
  const qberPercentage = result?.metrics.qber === null || result?.metrics.qber === undefined
    ? null
    : result.metrics.qber * 100;
  const starterName = result
    ? result.startedBy === currentClientId
      ? 'you'
      : participants.find((participant) => participant.id === result.startedBy)?.name
        ?? 'your room partner'
    : '';

  return (
    <div className="protocol-lab-layer">
      <button
        className="protocol-lab-backdrop"
        type="button"
        aria-label="Close BB84 Security Lab"
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="protocol-lab"
        role="dialog"
        aria-modal="true"
        aria-labelledby="protocol-lab-title"
        aria-describedby="protocol-lab-boundary"
      >
        <header className="protocol-lab__header">
          <span className="protocol-lab__mark" aria-hidden="true"><Atom size={23} /></span>
          <div>
            <span className="eyebrow">Chat key setup and teaching lab</span>
            <h2 id="protocol-lab-title">BB84 Security Lab</h2>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="Close protocol lab" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="protocol-lab__body">
          <p className="lab-introduction">Establish a chat key in both browsers. Explore the separate room simulation only if you want to inspect the teaching model.</p>
          <LabParticipants />
          <aside id="protocol-lab-boundary" className="lab-boundary lab-boundary--compact" role="note">
            <ShieldAlert size={18} aria-hidden="true" />
            <p><strong>Software simulation only.</strong> BB84 is simulated in the two browsers; this is not physical quantum key distribution.</p>
          </aside>

          <section className="lab-endpoint-bb84" aria-labelledby="endpoint-bb84-heading">
            <div className="lab-section-heading">
              <span><KeyRound size={17} /> Browser-to-browser key setup</span>
              <small className={`lab-mode-pill ${endpointRuntime.chatMode === 'BB84-ECDH hybrid active' ? 'lab-mode-pill--hybrid' : ''}`}>{endpointRuntime.chatMode === 'BB84-ECDH hybrid active' ? 'Hybrid key active' : 'ECDH-only chat active'}</small>
            </div>
            <p id="endpoint-bb84-heading">Alice and Bob each run BB84 in their browser. The chat switches to the hybrid key only after both confirm it.</p>
            <ol className="lab-protocol-steps" aria-label="Endpoint BB84 establishment steps">
              {endpointBb84Steps.map((step, index) => {
                const stepState = endpointBb84StepState(endpointBb84.status, index);
                return <li className={`lab-protocol-steps__${stepState}`} aria-current={stepState === 'current' ? 'step' : undefined} key={step}>
                  <span aria-hidden="true">{stepState === 'complete' ? <Check size={14} /> : index + 1}</span>
                  <strong>{step}</strong>
                </li>;
              })}
            </ol>
            <div className="lab-endpoint-progress">
              <label htmlFor="endpoint-bb84-progress">Key establishment progress <strong>{endpointBb84.status === 'complete' ? 100 : endpointBb84.status === 'failed' ? 0 : endpointBb84.percent}%</strong></label>
              <progress id="endpoint-bb84-progress" max={100} value={endpointBb84.status === 'complete' ? 100 : endpointBb84.status === 'failed' ? 0 : endpointBb84.percent} />
            </div>
            <div className="lab-qber-card" aria-label="BB84 sample error rate">
              <span>Sample error rate (QBER)</span>
              <strong>{endpointBb84.qberPpm === null ? 'Waiting for sample' : `${(endpointBb84.qberPpm / 10_000).toFixed(2)}%`}</strong>
              <small>{endpointBb84.status === 'complete' ? 'Measured by the endpoint exchange' : endpointBb84.status === 'failed' ? 'Last exchange stopped' : 'Shown after the shared sample is checked'}</small>
            </div>
            <button
              className="lab-run-button"
              type="button"
              disabled={!connected || !encryption.canSend || ['preparing', 'exchanging', 'sifting', 'sampling', 'reconciling', 'privacy_amplification', 'key_confirmation'].includes(endpointBb84.status)}
              onClick={() => onStartEndpointBb84(config)}
            >
              {['preparing', 'exchanging', 'sifting', 'sampling', 'reconciling', 'privacy_amplification', 'key_confirmation'].includes(endpointBb84.status)
                ? <><LoaderCircle className="spin" size={18} /> Exchange in progress</>
                : <><Play size={18} fill="currentColor" /> {endpointBb84.status === 'complete' ? 'Run BB84 again' : 'Start BB84 key exchange'}</>}
            </button>
            <div className={`lab-final-result lab-final-result--${endpointBb84.status}`} role={endpointBb84.status === 'failed' ? 'alert' : 'status'}>
              <strong>{endpointBb84.status === 'complete'
                ? endpointRuntime.chatMode === 'BB84-ECDH hybrid active' ? 'Hybrid chat key active' : 'BB84 completed · ECDH fallback active'
                : endpointBb84.status === 'failed' ? 'BB84 exchange failed'
                  : endpointRuntime.session === 'In progress' ? 'Establishing the hybrid chat key' : 'Ready to establish a hybrid chat key'}</strong>
              <p>{endpointBb84.status === 'complete'
                ? endpointRuntime.chatMode === 'BB84-ECDH hybrid active' ? 'Both browsers confirmed the contribution. New messages use the hybrid key.' : 'The BB84 contribution is confirmed but inactive. New messages use ECDH-only encryption.'
                : endpointBb84.status === 'failed' ? encryption.activeKeyMode === 'ecdh' ? 'The exchange stopped; ECDH-only chat remains active.' : 'The exchange stopped and no hybrid key was activated.'
                  : endpointRuntime.session === 'In progress' ? 'ECDH-only remains active until both browsers finish and confirm the exchange.' : 'Start the browser-to-browser exchange when both people are ready.'}</p>
              {endpointBb84.error && <small>{endpointBb84.error}</small>}
              {encryption.activeKeyMode === 'bb84_hybrid' && <button type="button" className="lab-run-button" onClick={onUseEcdhFallback}>Switch chat back to ECDH</button>}
            </div>
            <details className="lab-disclosure lab-endpoint-details">
              <summary>Detailed endpoint protocol status</summary>
              <EndpointBb84RuntimeSummary encryption={encryption} endpointBb84={endpointBb84} />
            </details>
          </section>

          <details className="lab-disclosure lab-room-teaching">
            <summary>Room-hosted teaching simulation · advanced</summary>
            <p className="lab-room-teaching__note">This separate room simulation demonstrates the BB84 steps for learning. Its output never contributes to chat encryption. Both approaches here are software simulations, not quantum hardware.</p>
            <details className="lab-disclosure lab-room-demo">
              <summary>Eavesdropper comparison</summary>
              <EavesdroppingDemo result={result} state={state} connected={connected} onRun={preset => {
                if (!onRun(preset)) return false;
                setConfig(preset);
                return true;
              }} />
            </details>
          <div className="protocol-lab__workspace">
            <form
              className="lab-settings"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                onRun(config);
              }}
            >
              <div className="lab-section-heading">
                <span><SlidersHorizontal size={17} /> Experiment settings</span>
                <small>Result shared with the room</small>
              </div>

              <label className="lab-control lab-control--select" htmlFor="bb84-qubits">
                <span className="lab-control__heading"><strong>Bits to prepare</strong></span>
                <span className="lab-control__description">More trials usually produce a steadier teaching result.</span>
                <select
                  id="bb84-qubits"
                  value={config.qubitCount}
                  disabled={running}
                  onChange={(event) => {
                    // Capture before React clears currentTarget or defers the updater.
                    const qubitCount = Number(event.currentTarget.value) as Bb84Config['qubitCount'];
                    setConfig((current) => ({ ...current, qubitCount }));
                  }}
                >
                  {BB84_QUBIT_COUNTS.map((count) => <option value={count} key={count}>{count} bits</option>)}
                </select>
              </label>

              <LabRange
                id="bb84-intercept"
                label="Eve’s interception"
                description="Chance that Eve intercepts each simulated transmission."
                value={Math.round(config.interceptProbability * 100)}
                min={0}
                max={100}
                step={5}
                disabled={running}
                onChange={(value) => updatePercentage('interceptProbability', value)}
              />
              <details className="lab-disclosure lab-advanced-settings">
                <summary>Experiment settings · advanced</summary>
              <label className="lab-control lab-control--seed" htmlFor="bb84-seed">
                <span className="lab-control__heading"><strong>Reproducible seed</strong></span>
                <span className="lab-control__description">Optional. Reuse an integer with the same settings to repeat a teaching run; leave blank for fresh randomness.</span>
                <input
                  id="bb84-seed"
                  aria-label="Reproducible seed"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  placeholder="Random"
                  value={config.seed ?? ''}
                  disabled={running}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!value) {
                      setConfig((current) => ({ ...current, seed: null }));
                      return;
                    }
                    const seed = Number(value);
                    if (Number.isSafeInteger(seed) && seed >= 0) {
                      setConfig((current) => ({ ...current, seed }));
                    }
                  }}
                />
              </label>

              <LabRange
                id="bb84-channel-error"
                label="Background noise"
                description="Simplified chance that a measured result flips."
                value={Math.round(config.noiseProbability * 100)}
                min={0}
                max={25}
                step={1}
                disabled={running}
                onChange={(value) => updatePercentage('noiseProbability', value)}
              />
              <LabRange
                id="bb84-sample"
                label="Sample to check"
                description="Share of matching results revealed to check for errors."
                value={Math.round(config.sampleRatio * 100)}
                min={10}
                max={50}
                step={5}
                disabled={running}
                onChange={(value) => updatePercentage('sampleRatio', value)}
              />
              <LabRange
                id="bb84-threshold"
                label="Acceptable error limit"
                description="Stop if the checked sample has more errors than this limit."
                value={Math.round(config.qberThreshold * 100)}
                min={1}
                max={25}
                step={1}
                disabled={running}
                onChange={(value) => updatePercentage('qberThreshold', value)}
              />

              </details>

              <button className="lab-run-button" type="submit" disabled={!connected || running}>
                {running
                  ? <><LoaderCircle className="spin" size={18} /> Experiment running…</>
                  : <><Play size={18} fill="currentColor" /> {result ? 'Run another experiment' : 'Start BB84 Experiment'}</>}
              </button>
              {!connected && <p className="lab-settings__hint">Connect to the room to run a shared experiment.</p>}
            </form>

            <section className="lab-results" aria-label="BB84 experiment result">
              <div className="lab-section-heading">
                <span><Activity size={17} /> Shared result</span>
                {result && <small>Started by {starterName} · {timeLabel(result.createdAt)}</small>}
              </div>

              {error && (
                <div className="lab-result-error" role="alert">
                  <AlertCircle size={18} aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              {running && (
                <div className="lab-running" role="status">
                  <span className="lab-running__orbit"><Atom size={27} /></span>
                  <strong>Running the software model</strong>
                  <p>Waiting for the room host’s result. It returns all stages together; individual stages are not streamed live. No result is shown until it arrives.</p>
                </div>
              )}

              {!running && !result && !error && (
                <div className="lab-empty-result">
                  <span><Eye size={24} /></span>
                  <h3>Follow a secret from start to finish</h3>
                  <p>Start an experiment, then explore seven steps using the actual result. Try no interception first, then increase Eve’s activity.</p>
                  <p>Private bits and key values are never displayed.</p>
                </div>
              )}

              {!running && result && decisionCopy && (
                <div className="lab-result-content">
                  <div className={`lab-final-result lab-final-result--${result.decision.status}`} role="status" aria-label="Room-hosted teaching result">
                    <strong>{decisionCopy.title}</strong>
                    <p>{decisionCopy.detail}</p>
                    <small>Sample error rate (QBER): {qberPercentage === null ? 'Unavailable' : `${qberPercentage.toFixed(2)}%`}</small>
                    <small>This room-hosted teaching run does not set chat keys.</small>
                  </div>
                  <details className="lab-disclosure lab-teaching-walkthrough">
                    <summary>Explore the teaching run step by step</summary>
                    <SecurityLabWalkthrough key={result.sessionId} result={result} />
                    <details className="lab-disclosure lab-technical-report">
                      <summary>Show technical details</summary>
                  <section className="lab-run-summary" aria-label="Recorded BB84 session settings">
                    <div className="lab-run-summary__heading">
                      <div>
                        <span>Recorded server result</span>
                        <strong>Recorded session settings</strong>
                      </div>
                      <time dateTime={result.createdAt}>{dateTimeLabel(result.createdAt)}</time>
                    </div>
                    <dl>
                      <div className="lab-run-summary__wide"><dt>Session ID</dt><dd><code>{result.sessionId}</code></dd></div>
                      <div><dt>Started by</dt><dd>{starterName}</dd></div>
                      <div><dt>Qubits</dt><dd>{result.config.qubitCount}</dd></div>
                      <div><dt>Channel error</dt><dd>{percentageLabel(result.config.noiseProbability)}</dd></div>
                      <div><dt>Intercept-resend</dt><dd>{percentageLabel(result.config.interceptProbability)}</dd></div>
                      <div><dt>Disclosed sample</dt><dd>{percentageLabel(result.config.sampleRatio)}</dd></div>
                      <div><dt>QBER threshold</dt><dd>{percentageLabel(result.config.qberThreshold)}</dd></div>
                      <div><dt>Seed</dt><dd>{result.config.seed === null ? 'Random' : result.config.seed}</dd></div>
                    </dl>
                    <p>These values belong to this received result. Changing the controls on the left does not alter the recorded run.</p>
                  </section>

                  <div className={`lab-decision lab-decision--${result.decision.status}`}>
                    <span className="lab-decision__icon" aria-hidden="true">
                      {result.decision.status === 'accepted' ? <Check size={22} /> : <X size={22} />}
                    </span>
                    <div>
                      <span>{result.decision.status === 'accepted' ? 'Sample accepted' : 'Sample rejected'}</span>
                      <strong>{decisionCopy.title}</strong>
                      <p>{decisionCopy.detail}</p>
                    </div>
                    <div className="lab-qber">
                      <span>Sampled QBER</span>
                      <strong>{qberPercentage === null ? 'N/A' : `${qberPercentage.toFixed(2)}%`}</strong>
                      <small>Limit {percentageLabel(result.config.qberThreshold)}</small>
                    </div>
                  </div>

                  <div className="lab-qber-track" aria-label={qberPercentage === null ? 'QBER unavailable' : `QBER ${qberPercentage.toFixed(2)} percent`}>
                    <span style={{ width: `${Math.min(qberPercentage ?? 0, 100)}%` }} />
                    <i style={{ left: `${Math.min(result.config.qberThreshold * 100, 100)}%` }} aria-hidden="true" />
                  </div>

                  <dl className="lab-metrics">
                    <div><dt>Transmitted</dt><dd>{result.metrics.transmitted}</dd></div>
                    <div className="lab-metric--ground-truth"><dt>Sim. intercepts <small>ground truth</small></dt><dd>{result.metrics.intercepted}</dd></div>
                    <div><dt>Sifted</dt><dd>{result.metrics.sifted}</dd></div>
                    <div><dt>Disclosed</dt><dd>{result.metrics.sample}</dd></div>
                    <div><dt>Mismatches</dt><dd>{result.metrics.mismatches}</dd></div>
                    <div><dt>After sample</dt><dd>{result.metrics.retained}</dd></div>
                  </dl>

                  <div className="lab-formula">
                    <span>Observed calculation</span>
                    <code>{result.metrics.mismatches} ÷ {result.metrics.sample} = {qberPercentage === null ? 'undefined' : `${qberPercentage.toFixed(2)}%`}</code>
                  </div>

                  <PostProcessingPanel result={result} />

                  <div className="lab-trace">
                    <div className="lab-trace__heading">
                      <div><strong>Teaching trace</strong><span>{result.trace.length} selected transmissions, with no raw bit values</span></div>
                      <span>{result.trace.length} rows</span>
                    </div>
                    <div className="lab-trace__legend">
                      <span><i className="legend-public" />Public comparison: bases, sifting and disclosed sample outcome</span>
                      <span><i className="legend-ground-truth" />Simulator ground truth: intercept flag, not directly observable in a real exchange</span>
                    </div>
                    <div className="lab-trace__scroll">
                      <table>
                        <thead><tr><th scope="col">#</th><th scope="col">Alice basis</th><th scope="col">Bob basis</th><th scope="col">Public basis check</th><th scope="col" className="trace-ground-truth">Intercept flag <small>simulator truth</small></th><th scope="col">Public sample</th></tr></thead>
                        <tbody>
                          {result.trace.map((row) => (
                            <tr key={row.index}>
                              <td>{row.index + 1}</td>
                              <td><span className={`basis-chip basis-chip--${row.aliceBasis.toLowerCase()}`}>{row.aliceBasis}</span></td>
                              <td><span className={`basis-chip basis-chip--${row.bobBasis.toLowerCase()}`}>{row.bobBasis}</span></td>
                              <td className={row.basisMatch ? 'trace-good' : 'trace-muted'}>{row.basisMatch ? 'Match' : 'Discard'}</td>
                              <td className={`trace-ground-truth ${row.intercepted ? 'trace-warn' : 'trace-muted'}`}>{row.intercepted ? 'Flagged' : 'None'}</td>
                              <td className={row.sampleComparison === 'mismatch' ? 'trace-bad' : row.sampleComparison === 'match' ? 'trace-good' : 'trace-muted'}>
                                {row.sampled ? row.sampleComparison : 'Not shown'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <aside className="lab-caveat">
                    <AlertCircle size={17} aria-hidden="true" />
                    <p><strong>Read the result carefully.</strong> The intercept count and row flags are simulator ground truth, not values Alice and Bob would directly observe. Noise and simulated interception can both raise QBER, so QBER alone does not prove eavesdropping. The trusted-server model exposes no key, discards its temporary material, and never supplies, verifies, or changes the live chat keys. It does not provide a physical security guarantee.</p>
                  </aside>
                    </details>
                  </details>
                </div>
              )}
            </section>
          </div>
          </details>
        </div>
      </section>
    </div>
  );
}

interface ChatViewProps {
  session: ChatSession;
  snapshot: RoomSnapshot;
  networkStatus: NetworkStatus | null;
  onLeave: () => void;
}

function ChatView({ session, snapshot, networkStatus, onLeave }: ChatViewProps) {
  const {
    messages: wireMessages,
    participants,
    typingNames,
    connection,
    encryption,
    bb84Result,
    bb84State,
    bb84Error,
    endpointBb84,
    securityTrace,
    clearSecurityTrace,
    sendMessage,
    retryMessage,
    verifyEncryption,
    clearEncryptionVerification,
    acceptChangedKey,
    retryEncryption,
    runBb84,
    startEndpointBb84,
    useEcdhFallback,
    setTyping,
    reconnect,
  } = useChat(session, snapshot);
  const { ensurePeerMedia } = useMediaCapability({ messages: wireMessages, session, encryption, sendMessage });
  const messages = useMemo(() => wireMessages.filter(message => !isMediaControl(message.text)), [wireMessages]);
  const [draft, setDraft] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [compactWorkspace, setCompactWorkspace] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  const [labOpen, setLabOpen] = useState(false);
  const [presentationOpen, setPresentationOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fileStage, setFileStage] = useState('Checking partner support…');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const uploadRef = useRef<AbortController | null>(null);
  const attachmentContextRef = useRef({ canSend: false, keyId: null as string | null });
  attachmentContextRef.current = { canSend: connection.state === 'connected' && encryption.canSend, keyId: encryption.sessionKeyId };
  const [atBottom, setAtBottom] = useState(true);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const labTriggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mastheadRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const conversationHeadingRef = useRef<HTMLHeadingElement>(null);
  const notesTriggerRef = useRef<HTMLButtonElement>(null);
  const skipLinkRef = useRef<HTMLAnchorElement>(null);
  const typingStopTimer = useRef<number | undefined>();
  const previousCount = useRef(messages.length);
  const notesOpen = sidebarOpen && compactWorkspace;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 980px)');
    const onChange = (event: MediaQueryListEvent) => {
      setCompactWorkspace(event.matches);
      if (!event.matches) setSidebarOpen(false);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!notesOpen) return;
    const background = [mastheadRef.current, conversationRef.current, skipLinkRef.current]
      .filter((element): element is HTMLElement => element !== null);
    const previous = background.map(element => element.hasAttribute('inert'));
    const trigger = notesTriggerRef.current;
    const heading = conversationHeadingRef.current;
    background.forEach(element => element.setAttribute('inert', ''));
    return () => {
      background.forEach((element, index) => {
        if (!previous[index]) element.removeAttribute('inert');
      });
      // Restore only after lifting inertness; a desktop resize hides the trigger.
      const target = window.matchMedia('(max-width: 980px)').matches
        ? trigger : heading;
      if (target?.isConnected) target.focus();
    };
  }, [notesOpen]);

  useEffect(() => {
    if (!selectedFile) { setFilePreview(null); return; }
    const url = URL.createObjectURL(selectedFile);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  useEffect(() => () => { uploadRef.current?.abort(); uploadRef.current = null; }, []);

  const selectFile = (file: File | undefined) => {
    if (!file || uploadRef.current) return;
    setFileError(null);
    try { validateAttachmentFile(file); setSelectedFile(file); }
    catch (error) { setFileError(error instanceof Error ? error.message : 'Choose a supported image or video.'); }
  };

  const sendFile = async () => {
    if (!selectedFile || uploadRef.current || !attachmentContextRef.current.canSend) return;
    const controller = new AbortController();
    uploadRef.current = controller;
    const keyId = attachmentContextRef.current.keyId;
    setUploading(true);
    setFileStage('Checking partner support…');
    setFileError(null);
    try {
      await ensurePeerMedia(controller.signal);
      if (controller.signal.aborted) return;
      if (!attachmentContextRef.current.canSend || keyId !== attachmentContextRef.current.keyId) {
        throw new Error('The connection or device key changed. Review security, then send the file again.');
      }
      setFileStage('Encrypting and uploading…');
      const manifest = await prepareAttachment(selectedFile, session.roomCode, controller.signal);
      if (controller.signal.aborted) return;
      if (!attachmentContextRef.current.canSend || keyId !== attachmentContextRef.current.keyId) {
        throw new Error('The connection or device key changed. Review security, then send the file again.');
      }
      if (!sendMessage(manifest)) throw new Error('The file message was not sent. Reconnect and retry.');
      setSelectedFile(null);
    } catch (error) {
      if (!controller.signal.aborted) setFileError(error instanceof Error ? error.message : 'Could not send the file. Try again.');
    } finally {
      if (uploadRef.current === controller) { uploadRef.current = null; setUploading(false); }
    }
  };

  const cancelFile = () => {
    uploadRef.current?.abort();
    uploadRef.current = null;
    setUploading(false);
    setSelectedFile(null);
    setFileError(null);
    attachButtonRef.current?.focus();
  };

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  }, [draft]);

  const onlineCount = participants.filter((participant) => participant.online).length;
  const closeLab = useCallback(() => setLabOpen(false), []);
  const closePresentation = useCallback(() => setPresentationOpen(false), []);
  const closeSecurity = useCallback(() => setSecurityOpen(false), []);
  const openSecurity = useCallback(() => {
    setSidebarOpen(false);
    setSecurityOpen(true);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    endRef.current?.scrollIntoView?.({ behavior, block: 'end' });
    setUnreadBelow(0);
    setAtBottom(true);
  }, []);

  useEffect(() => {
    const lastMessage = messages.at(-1);
    const isMine = lastMessage?.senderId === session.clientId;
    if (messages.length > previousCount.current) {
      if (atBottom || isMine) {
        scrollToLatest(isMine ? 'smooth' : 'auto');
      } else {
        setUnreadBelow((count) => count + (messages.length - previousCount.current));
      }
    }
    previousCount.current = messages.length;
  }, [atBottom, messages, scrollToLatest, session.clientId]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        setSecurityOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(typingStopTimer.current);
    setTyping(false);
  }, [setTyping]);

  const copyRoom = async () => {
    try {
      await navigator.clipboard.writeText(session.roomCode);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = session.roomCode;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  };

  const submitMessage = () => {
    const cleanDraft = draft.trim();
    if (!cleanDraft || connection.state !== 'connected') return;
    if (UTF8_ENCODER.encode(cleanDraft).byteLength > MAX_ENCRYPTED_PLAINTEXT_BYTES) {
      setComposerError(`That message is too large after UTF-8 encoding. Use at most ${MAX_ENCRYPTED_PLAINTEXT_BYTES.toLocaleString()} bytes.`);
      return;
    }
    if (sendMessage(draft)) {
      setDraft('');
      setComposerError(null);
      window.clearTimeout(typingStopTimer.current);
      setTyping(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitMessage();
    }
  };

  const updateDraft = (value: string) => {
    setDraft(value.slice(0, MAX_MESSAGE_LENGTH));
    setComposerError(null);
    if (value.trim()) {
      setTyping(true);
      window.clearTimeout(typingStopTimer.current);
      typingStopTimer.current = window.setTimeout(() => setTyping(false), 1_200);
    } else {
      setTyping(false);
    }
  };

  const handleScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    setAtBottom(nearBottom);
    if (nearBottom) setUnreadBelow(0);
  };

  const canCompose = connection.state === 'connected' && encryption.canSend;
  const composerPlaceholder = connection.state !== 'connected'
    ? 'Reconnect to send messages'
    : encryption.state === 'waiting_for_peer'
      ? 'Waiting for your partner’s encryption key…'
      : encryption.state === 'key_changed'
        ? 'Review the changed device key before sending'
        : encryption.state === 'failed'
          ? 'Encryption is paused'
          : !encryption.canSend
            ? 'Setting up encryption…'
            : 'Write a message…';

  return (
    <div className="chat-app cafe-workspace">
      <a ref={skipLinkRef} className="skip-link" href="#message-composer">Skip to message composer</a>
      <header ref={mastheadRef} className="cafe-masthead">
        <div className="cafe-masthead__brand" aria-label="QKD Chat"><strong>qkd.</strong></div>
        <nav className="cafe-masthead__nav" aria-label="Workspace">
          <a href="#conversation-heading" aria-current="page">Conversation</a>
          <button className="presentation-trigger" type="button" aria-haspopup="dialog" onClick={() => setPresentationOpen(true)}>
            <Activity size={16} aria-hidden="true" /><span>Encryption demo</span>
          </button>
          <button ref={labTriggerRef} className="protocol-lab-trigger" type="button"
            aria-label="Open BB84 Security Lab" aria-haspopup="dialog" onClick={() => setLabOpen(true)}>
            <FlaskConical size={16} aria-hidden="true" /><span>BB84 lab</span>
          </button>
        </nav>
        <div className="cafe-masthead__status" role="group" aria-label="Connection and encryption status">
          <ConnectionBadge connection={connection} />
          <EncryptionBadge encryption={encryption} onOpen={openSecurity} />
        </div>
      </header>

      <SecurityPanel
        open={securityOpen}
        encryption={encryption}
        endpointBb84={endpointBb84}
        onClose={closeSecurity}
        onVerify={verifyEncryption}
        onClearVerification={clearEncryptionVerification}
        onAcceptChangedKey={acceptChangedKey}
        onRetry={retryEncryption}
      />

      <div className="cafe-workspace__body">
      <main ref={conversationRef} className="conversation-shell" aria-labelledby="conversation-heading">
        <header className="conversation-header cafe-conversation-heading">
          <div>
            <span className="cafe-conversation-heading__eyebrow">A private room for two</span>
            <h1 ref={conversationHeadingRef} id="conversation-heading" tabIndex={-1}>The conversation</h1>
            <p>{onlineCount < 2 ? 'Waiting for your room partner.' : 'Both participants are here.'}</p>
          </div>
          <button ref={notesTriggerRef} type="button" className="cafe-notes-trigger" onClick={() => { if (compactWorkspace) setSidebarOpen(true); }}
            aria-label="Open room details" aria-controls="room-notes" aria-expanded={notesOpen}>
            <Menu size={18} aria-hidden="true" /><span>Room notes</span>
          </button>
        </header>

        <ConnectionNotice connection={connection} onReconnect={reconnect} />

        {connection.state === 'connected' && !['encrypted_unverified', 'encrypted_verified'].includes(encryption.state) && (
          <div className={`encryption-notice encryption-notice--${encryption.state}`} role="status" aria-live="polite">
            {['idle', 'setting_up'].includes(encryption.state)
              ? <LoaderCircle className="spin" size={16} />
              : <KeyRound size={16} />}
            <span>{encryptionCopy(encryption).detail}</span>
            <button type="button" onClick={openSecurity}>
              View details
            </button>
          </div>
        )}

        {connection.state === 'connected' && encryption.keyStorage === 'session' && (
          <div className="session-key-notice" role="status" aria-label="Session-only encryption key warning">
            <KeyRound size={16} aria-hidden="true" />
            <span><strong>Session-only encryption key.</strong> Keep this tab open. Refreshing can make earlier encrypted messages unavailable.</span>
            <button type="button" onClick={openSecurity}>View details</button>
          </div>
        )}

        <section
          className="message-list"
          ref={listRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Conversation messages"
        >
          {messages.length === 0 && connection.state === 'connecting' ? (
            <div className="loading-state" role="status">
              <span className="loading-state__orbit"><Atom size={25} /></span>
              <strong>Opening your room</strong>
              <span>Loading recent messages and presence…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state__art" aria-hidden="true">
                <MessageCircle size={25} />
                <i /><i /><i />
              </span>
              <h2>Your room is ready</h2>
              <p>{session.roomRoute === 'host'
                ? <>Share the complete code <strong>{session.roomCode}</strong>. Your partner can enter it on their own Mac.</>
                : session.roomRoute === 'partner'
                  ? <>This Mac is linking to the private room host{session.roomHost ? <> at <strong>{session.roomHost}</strong></> : null}.</>
                  : <>Share <strong>{session.roomCode}</strong> with one person using this server, then send the first message.</>}</p>
              <button type="button" onClick={copyRoom}>
                {copied ? <Check size={16} /> : <Clipboard size={16} />}
                {copied ? 'Room code copied' : 'Copy room code'}
              </button>
            </div>
          ) : (
            <div className="message-stack">
              {messages.map((message, index) => {
                const previous = messages[index - 1];
                const grouped = Boolean(
                  previous
                    && previous.kind === 'message'
                    && previous.senderId === message.senderId
                    && Date.parse(message.sentAt) - Date.parse(previous.sentAt) < 5 * 60_000,
                );
                const showDate = !previous || !sameCalendarDay(previous.sentAt, message.sentAt);
                return (
                  <div key={message.id}>
                    {showDate && <div className="date-divider"><span>{dateLabel(message.sentAt)}</span></div>}
                    <MessageBubble
                      roomId={session.roomCode}
                      message={message}
                      mine={message.senderId === session.clientId}
                      grouped={grouped}
                      onRetry={retryMessage}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div ref={endRef} aria-hidden="true" />
        </section>

        {!atBottom && unreadBelow > 0 && (
          <button className="new-message-button" type="button" onClick={() => scrollToLatest()}>
            <ArrowDown size={15} /> {unreadBelow} new {unreadBelow === 1 ? 'message' : 'messages'}
          </button>
        )}

        <div className="typing-line" aria-live="polite">
          {typingNames.length > 0 && (
            <span>
              <i /><i /><i />
              {typingNames.length === 1 ? `${typingNames[0]} is typing` : 'Your partner is typing'}
            </span>
          )}
        </div>

        <footer className="composer-shell">
          {selectedFile && (
            <section className="file-review" aria-label="Attachment preview" aria-busy={uploading}>
              {filePreview && (selectedFile.type.startsWith('image/')
                ? <img src={filePreview} alt="Selected image preview" />
                : <video src={filePreview} controls preload="metadata" aria-label="Selected video preview" />)}
              <div className="file-review__info"><strong>{selectedFile.name}</strong><span>{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB · Encrypted before upload</span>
                {uploading && <span role="status"><LoaderCircle size={14} className="spin" /> {fileStage}</span>}
              </div>
              <div className="file-review__actions">
                <button type="button" onClick={cancelFile}>{uploading ? 'Cancel upload' : 'Remove file'}</button>
                <button type="button" onClick={() => void sendFile()} disabled={!canCompose || uploading}>{uploading ? 'Sending…' : 'Send file'}</button>
              </div>
            </section>
          )}
          {fileError && <p className="file-error" role="alert">{fileError}</p>}
          <div className="composer">
            <input className="file-picker" ref={fileInputRef} type="file" accept={ATTACHMENT_ACCEPT} aria-label="Choose image or video" disabled={!canCompose || uploading}
              onChange={(event) => { selectFile(event.target.files?.[0]); event.target.value = ''; }} />
            <button ref={attachButtonRef} className="attach-button" type="button" aria-label="Attach image or video" title="Image or video · up to 10 MB" disabled={!canCompose || uploading}
              onClick={() => fileInputRef.current?.click()}><Paperclip size={20} /></button>
            <textarea
              id="message-composer"
              ref={composerRef}
              aria-label="Message"
              aria-invalid={composerError ? 'true' : undefined}
              aria-describedby={composerError ? 'composer-error' : undefined}
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder={composerPlaceholder}
              value={draft}
              disabled={!canCompose}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <span className={`character-count${draft.length >= MAX_MESSAGE_LENGTH * 0.9 ? ' is-visible' : ''}`}>
              {draft.length}/{MAX_MESSAGE_LENGTH}
            </span>
            <button
              type="button"
              className="send-button"
              aria-label="Send message"
              title="Send message"
              disabled={!canCompose || !draft.trim()}
              onClick={submitMessage}
            >
              <span>Send</span><SendHorizontal size={18} aria-hidden="true" />
            </button>
          </div>
          {composerError && (
            <p className="composer-error" id="composer-error" role="alert">
              <CircleAlert size={13} aria-hidden="true" /> {composerError}
            </p>
          )}
          <p>
            <span className="media-limit">Images & videos up to 10 MB</span>
            <span className="composer-shortcut"><kbd>Enter</kbd> to send</span>
          </p>
        </footer>
      </main>

      <ChatSidebar
        open={notesOpen}
        session={session}
        networkStatus={networkStatus}
        participants={participants}
        connection={connection}
        copied={copied}
        onCopy={copyRoom}
        onClose={() => setSidebarOpen(false)}
        onLeave={onLeave}
      />

      </div>

      <PresentationDialog open={presentationOpen} events={securityTrace} connection={connection} encryption={encryption} endpointBb84={endpointBb84}
        messages={wireMessages} currentClientId={session.clientId} onSend={sendMessage}
        onClear={clearSecurityTrace} onClose={closePresentation} onOpenLab={() => setLabOpen(true)} onOpenSecurity={openSecurity} />

      <ProtocolLab
        open={labOpen}
        encryption={encryption}
        connection={connection}
        participants={participants}
        currentClientId={session.clientId}
        result={bb84Result}
        state={bb84State}
        error={bb84Error}
        endpointBb84={endpointBb84}
        returnFocusRef={labTriggerRef}
        onRun={runBb84}
        onStartEndpointBb84={startEndpointBb84}
        onUseEcdhFallback={useEcdhFallback}
        onClose={closeLab}
      />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(EMPTY_SNAPSHOT);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null);

  const handleJoin = async (input: {
    displayName: string;
    roomCode: string;
    mode: 'create' | 'join';
  }, confirmedNetwork: NetworkStatus | null) => {
    const result: JoinRoomResult = await joinRoom(input);
    savePreference(NAME_STORAGE_KEY, result.displayName);
    savePreference(ROOM_STORAGE_KEY, result.roomCode);
    setNetworkStatus(confirmedNetwork);
    setSnapshot({
      messages: result.messages,
      participants: result.participants,
      e2eeRequired: result.e2eeRequired,
    });
    setSession({
      clientId: result.clientId,
      displayName: result.displayName,
      roomCode: result.roomCode,
      roomRoute: result.roomRoute,
      roomHost: result.roomHost,
    });
  };

  const leaveRoom = () => {
    setSession(null);
    setSnapshot(EMPTY_SNAPSHOT);
    setNetworkStatus(null);
  };

  return session ? (
    <ChatView session={session} snapshot={snapshot} networkStatus={networkStatus} onLeave={leaveRoom} />
  ) : (
    <Onboarding onJoin={handleJoin} />
  );
}
