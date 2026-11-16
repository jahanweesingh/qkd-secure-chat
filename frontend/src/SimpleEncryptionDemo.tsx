import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, KeyRound, Lock, SendHorizontal } from 'lucide-react';
import type { ChatMessage, ConnectionInfo, EncryptionInfo } from './types';
import type { SecurityTraceEvent } from './securityTrace';
import { isAttachmentMessage } from './attachments';
import { isMediaControl } from './useMediaCapability';
import { LEARNING_MAX_BYTES, runLearningEncryption } from './learningCrypto';
import type { LearningEncryptionResult } from './learningCrypto';
import './simple-encryption-demo.css';

export interface SimpleEncryptionDemoProps {
  messages: ChatMessage[];
  currentClientId: string;
  connection: ConnectionInfo;
  encryption: EncryptionInfo;
  events: SecurityTraceEvent[];
  onSend: (text: string) => boolean;
}

type Mode = 'learning' | 'live';

function Value({ label, value }: { label: string; value: string }) {
  return <div className="simple-encryption__value"><dt>{label}</dt><dd><code>{value}</code></dd></div>;
}

/** A local teaching workspace. Production secrets are never passed to this component. */
export function SimpleEncryptionDemo({ messages, currentClientId, connection, encryption, events, onSend }: SimpleEncryptionDemoProps) {
  const inputId = useId();
  const errorId = useId();
  const [mode, setMode] = useState<Mode>('learning');
  const [draft, setDraft] = useState('hi');
  const [result, setResult] = useState<LearningEncryptionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  useEffect(() => () => { generation.current += 1; }, []);

  // Prefix checks deliberately exclude malformed manifests too: they can contain file keys.
  const ordinaryMessages = messages.filter(message => message.kind === 'message'
    && !isAttachmentMessage(message.text) && !isMediaControl(message.text));
  const message = ordinaryMessages.at(-1);
  const outgoing = message?.senderId === currentClientId;
  const related = message?.clientMessageId ? events.filter(event => event.source === 'live'
    && event.messageId === message.clientMessageId
    && event.direction === (outgoing ? 'outgoing' : 'incoming')) : [];
  const latestSend = [...related].reverse().find(event =>
    ['message_encrypted', 'ciphertext_sent', 'message_failed', 'relay_accepted'].includes(event.kind));
  const latestOpen = [...related].reverse().find(event =>
    event.kind === 'message_decrypted' || event.kind === 'integrity_failed');
  const acknowledged = outgoing && latestSend?.kind === 'relay_accepted' ? latestSend : undefined;
  const newestEncryption = related.reduce((last, event, index) => event.kind === 'message_encrypted' ? index : last, -1);
  const decrypted = latestOpen?.kind === 'message_decrypted' && message?.security === 'encrypted'
    && related.indexOf(latestOpen) > newestEncryption;
  const safeText = message?.security === 'encrypted' && latestOpen?.kind !== 'integrity_failed' ? message.text : null;
  const payload = message?.encryption;
  const canSend = connection.state === 'connected' && encryption.canSend;
  const learning = mode === 'learning';

  const resetExample = () => {
    generation.current += 1;
    running.current = false;
    setBusy(false); setResult(null); setError(null);
  };
  const changeMode = (next: Mode) => { if (mode !== next) { resetExample(); setMode(next); } };
  const updateDraft = (text: string) => { resetExample(); setDraft(text); };

  const run = async () => {
    if (running.current) return;
    if (!draft.trim() || new TextEncoder().encode(draft).byteLength > LEARNING_MAX_BYTES) {
      setError(`Enter a short message, up to ${LEARNING_MAX_BYTES} UTF-8 bytes.`);
      inputRef.current?.focus(); return;
    }
    setError(null);
    if (!learning) {
      if (!canSend || !onSend(draft)) setError('The message was not sent. Check the connection and device verification, then try again.');
      return;
    }
    const request = ++generation.current;
    running.current = true;
    setBusy(true); setResult(null);
    try {
      const next = await runLearningEncryption(draft);
      if (generation.current === request) setResult(next);
    } catch {
      if (generation.current === request) setError('This browser could not complete the encryption example. Open the app on localhost or HTTPS and try again.');
    } finally {
      if (generation.current === request) { running.current = false; setBusy(false); }
    }
  };

  const backendStatus = !message ? 'Send a message to see the backend response.'
    : related.length === 0 ? 'Recorded message · no live backend response retained.'
      : acknowledged ? 'Backend accepted the encrypted message for storage and relay.'
        : outgoing && latestSend?.kind === 'message_failed' ? 'Sending failed. No successful backend response is shown.'
          : outgoing ? 'Waiting for the backend acknowledgement.'
            : 'Encrypted envelope received from the backend.';

  return <section className="simple-encryption" aria-label="Message encryption example">
    <aside className="simple-encryption__controls" aria-label="Message controls">
    <h3 className="simple-encryption__control-title">Try a message</h3>
    <div className="simple-encryption__toolbar">
      <div className="simple-encryption__modes" role="group" aria-label="Example mode">
        <button type="button" aria-pressed={learning} onClick={() => changeMode('learning')}>Learn with keys</button>
        <button type="button" aria-pressed={!learning} onClick={() => changeMode('live')}>Live chat</button>
      </div>
    </div>

    <p className="simple-encryption__intro">{learning
      ? 'Real encryption, entirely in this browser. Fresh learning keys for each run, separate from your chat.'
      : 'Send a message to your partner and inspect its encrypted envelope.'}</p>

    <form className="simple-encryption__form" noValidate onSubmit={event => { event.preventDefault(); void run(); }}>
      <label htmlFor={inputId}>Your message</label>
      <div className="simple-encryption__input-row">
        <input ref={inputRef} id={inputId} type="text" value={draft} maxLength={512}
          autoComplete="off" spellCheck={false} onChange={event => updateDraft(event.target.value)}
          aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />
        <button className="simple-encryption__run" type="submit" disabled={busy || (!learning && !canSend)}>
          {learning ? <Lock size={16} aria-hidden="true" /> : <SendHorizontal size={16} aria-hidden="true" />}
          {busy ? 'Encrypting…' : learning ? 'Encrypt & decrypt' : 'Send & watch'}
        </button>
      </div>
      <p id={errorId} className={`simple-encryption__feedback${error ? ' simple-encryption__feedback--error' : ''}`} role="status">
        {error || (!learning && !canSend
          ? 'Sending is paused until the connection and chat keys are ready. You can still use Learn with keys.'
          : busy ? 'Creating keys and encrypting your message…' : '')}
      </p>
    </form>
    </aside>

    <div className="simple-encryption__results">
    <header className="simple-encryption__result-heading">
      <h3>Message journey</h3>
      <span>{learning ? result ? 'Example complete' : busy ? 'Working in your browser' : 'Ready when you are' : 'Your latest text message'}</span>
    </header>
    <div className="simple-encryption__flow" aria-label={learning ? 'Local encryption result' : 'Actual message result'} aria-busy={busy}>
      <div className="simple-encryption__step">
        <span className="simple-encryption__step-label">1 <span>{learning ? 'Write' : outgoing ? 'You wrote' : 'Message text'}</span></span>
        <p className="simple-encryption__plain">{learning ? result?.plaintext ?? '—' : safeText ?? '—'}</p>
        <span className="simple-encryption__caption">{learning ? 'Readable text' : message ? 'Latest ordinary text message' : 'No text message yet'}</span>
      </div>
      <ArrowRight className="simple-encryption__arrow" size={19} aria-hidden="true" />
      <div className="simple-encryption__step simple-encryption__step--cipher">
        <span className="simple-encryption__step-label">2 <span>{learning ? 'Encrypt' : 'Encrypted'}</span></span>
        <code className="simple-encryption__cipher">{learning ? result?.combinedCiphertextHex ?? '—' : payload?.ciphertext ?? '—'}</code>
        <span className="simple-encryption__caption">{learning ? 'Ciphertext + authentication tag · hex' : 'Actual ciphertext + tag · base64url'}</span>
      </div>
      <ArrowRight className="simple-encryption__arrow" size={19} aria-hidden="true" />
      <div className="simple-encryption__step">
        <span className="simple-encryption__step-label">3 <span>{learning ? 'Decrypt' : outgoing ? 'Check local echo' : 'Decrypt here'}</span></span>
        <p className="simple-encryption__plain">{learning ? result?.decrypted ?? '—' : decrypted ? safeText : '—'}</p>
        <span className="simple-encryption__caption">{learning
          ? result ? 'Recovered using Bob’s derived key' : 'Run the example to see the result'
          : latestOpen?.kind === 'integrity_failed' ? 'Authentication failed · contents withheld'
            : decrypted ? outgoing ? 'Your returned envelope opened locally' : 'Integrity checked by this browser'
              : 'No successful local decryption observed'}</span>
      </div>
    </div>

    {learning && result && <>
      <div className="simple-encryption__key">
        <KeyRound size={19} aria-hidden="true" />
        <div><strong>Learning key · never used for chat</strong><code>{result.aliceToBobKeyHex}</code>
          <span>The actual 256-bit AES key used above, shown in hex.</span></div>
        <Check size={17} aria-label="Encryption and decryption completed" />
      </div>
      <details className="simple-encryption__details">
        <summary>See all example keys and values</summary>
        <p>Alice and Bob are both represented locally. Each derives the same secret independently. These visible keys belong only to this example; they are discarded from this view when you edit, switch modes or close it.</p>
        <dl>
          <Value label="Alice’s private key · hex" value={result.alicePrivateHex} />
          <Value label="Alice’s public key · hex" value={result.alicePublicHex} />
          <Value label="Bob’s private key · hex" value={result.bobPrivateHex} />
          <Value label="Bob’s public key · hex" value={result.bobPublicHex} />
          <Value label="Shared ECDH secret · hex" value={result.sharedSecretHex} />
          <Value label="Alice → Bob AES key · hex" value={result.aliceToBobKeyHex} />
          <Value label="Bob → Alice AES key · hex" value={result.bobToAliceKeyHex} />
          <Value label="HKDF salt · hex" value={result.hkdfSaltHex} />
          <Value label="HKDF context · Alice → Bob" value={result.aliceToBobInfo} />
          <Value label="HKDF context · Bob → Alice" value={result.bobToAliceInfo} />
          <Value label="IV / nonce · hex" value={result.ivHex} />
          <Value label="Ciphertext without tag · hex" value={result.ciphertextHex} />
          <Value label="Authentication tag · hex" value={result.tagHex} />
          <Value label="Authenticated context" value={result.aad} />
        </dl>
      </details>
    </>}

    {!learning && <>
      <p className="simple-encryption__backend" role="status"><span className={acknowledged ? 'simple-encryption__observed' : ''}>{acknowledged && <Check size={15} aria-hidden="true" />}{backendStatus}</span>
        <small>{outgoing ? 'Server acceptance and your local echo do not prove your partner decrypted it.' : 'These observations belong to this browser.'}</small>
      </p>
      {payload && <details className="simple-encryption__details">
        <summary>Inspect the actual encrypted envelope</summary>
        <p>These public values come from this message. Key identifiers identify the keys; they are not secret keys.</p>
        <pre>{JSON.stringify({ version: payload.version, algorithm: payload.algorithm,
          client_message_id: message?.clientMessageId, key_id: payload.keyId,
          sender_key_id: payload.senderKeyId, iv: payload.iv, ciphertext: payload.ciphertext }, null, 2)}</pre>
        {acknowledged && <><h4>Backend acknowledgement</h4><pre>{JSON.stringify({ type: 'message_ack',
          client_message_id: acknowledged.messageId,
          ...(acknowledged.serverMessageId ? { message_id: acknowledged.serverMessageId } : {}),
          ...(acknowledged.serverSentAt ? { sent_at: acknowledged.serverSentAt } : {}),
          ...(typeof acknowledged.duplicate === 'boolean' ? { duplicate: acknowledged.duplicate } : {}),
        }, null, 2)}</pre></>}
      </details>}
    </>}
    </div>
  </section>;
}
