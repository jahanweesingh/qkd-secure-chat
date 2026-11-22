import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChatMessage, ConnectionInfo, EncryptionInfo } from './types';
import type { SecurityTraceEvent } from './securityTrace';
import { LiveSecurityView } from './LiveSecurityView';
import { SimpleEncryptionDemo } from './SimpleEncryptionDemo';
import type { EndpointBb84Progress } from './bb84ChatSession';
import './presentation-dialog.css';

interface Props {
  open: boolean;
  events: SecurityTraceEvent[];
  connection: ConnectionInfo;
  encryption: EncryptionInfo;
  endpointBb84: EndpointBb84Progress;
  messages: ChatMessage[];
  currentClientId: string;
  onSend: (text: string) => boolean;
  onClear: () => void;
  onClose: () => void;
  onOpenLab: () => void;
  onOpenSecurity: () => void;
}

/** Native modal supplies background inertness and focus restoration; Tab wraps locally. */
export function PresentationDialog({ open, onClose, onOpenLab, onOpenSecurity, messages, currentClientId, onSend, ...view }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);

  const changeView = (action: () => void) => {
    dialogRef.current?.close();
    onClose();
    action();
  };

  return (
    <dialog ref={dialogRef} className="presentation-dialog" aria-labelledby="presentation-title"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
        )).filter(element => {
          // All closed ancestors matter: a summary inside another closed
          // disclosure is hidden too, even if it is its own first summary.
          let ancestor = element.parentElement;
          while (ancestor && ancestor !== event.currentTarget) {
            if (ancestor instanceof HTMLDetailsElement && !ancestor.open
              && ancestor.querySelector(':scope > summary') !== element) return false;
            ancestor = ancestor.parentElement;
          }
          return true;
        });
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      {open && <div className="presentation-dialog__surface">
        <header className="presentation-dialog__header">
          <div><span className="presentation-dialog__eyebrow">Encryption studio</span>
            <h2 id="presentation-title">See what happens to “hi”</h2></div>
          <button ref={closeRef} type="button" className="icon-button" aria-label="Close encryption demo" onClick={onClose}><X size={21} /></button>
        </header>
        <div className="presentation-dialog__body">
          <SimpleEncryptionDemo messages={messages} currentClientId={currentClientId} onSend={onSend}
            events={view.events} connection={view.connection} encryption={view.encryption} />
          <section className="presentation-dialog__reading" aria-label="Further reading">
          <h3>Further reading</h3>
          <details className="packet-guide presentation-observations">
            <summary>Live activity & security details</summary>
            <LiveSecurityView {...view} onOpenLab={() => changeView(onOpenLab)} onOpenSecurity={() => changeView(onOpenSecurity)} />
          </details>
          <details className="packet-guide">
            <summary>Packet capture guide</summary>
            <p>This view records browser events. Wireshark is the separate tool for observing actual network packets on your own demonstration Macs.</p>
            <ol>
              <li><strong>Capture on a participating Mac.</strong> Select the network interface connecting the two Macs (usually Wi-Fi). Capture only the demo traffic with <code>tcp port 8080</code>; add <code>and host PEER_IP</code> using the other Mac’s private address.</li>
              <li><strong>Start before joining a fresh room.</strong> Both browsers stay on <code>http://localhost:8080</code>. Their backends exchange encrypted messages over the LAN. Send a harmless, distinctive demo sentence from the other Mac.</li>
              <li><strong>Inspect the WebSocket conversation.</strong> Use Wireshark’s display filter <code>tcp.port == 8080</code>, then Follow → WebSocket Stream where available. The public-key exchange and ciphertext are visible. AES keys and your sentence are not sent as plaintext.</li>
              <li><strong>Explain what is still visible.</strong> Room codes, display names, public keys, timing and sizes are metadata. A packet capture is a demonstration, not proof against every attack. Stop the capture after the demo.</li>
            </ol>
            <p>For a one-Mac demonstration, use the loopback interface for localhost traffic. In Chrome, Network → WS → Messages also shows WebSocket frames without capturing the LAN. Neither observation means the BB84 model detected a listener.</p>
            <a href="https://www.wireshark.org/docs/wsug_html_chunked/ChAdvFollowStreamSection.html" target="_blank" rel="noreferrer">Wireshark stream inspection guide ↗</a>
          </details>
          </section>
        </div>
      </div>}
    </dialog>
  );
}
