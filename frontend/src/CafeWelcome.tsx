import type { ReactNode } from 'react';
import { ArrowUpRight, LockKeyhole } from 'lucide-react';
import './cafe-welcome.css';

/** Presentation only. The existing room form owns validation and joining. */
export function CafeWelcome({ children }: { children: ReactNode }) {
  return (
    <main className="cafe-entry">
      <header className="cafe-entry__masthead">
        <a className="skip-link" href="#display-name">Skip to room form</a>
        <div className="cafe-wordmark" aria-label="QKD"><span>qkd.</span></div>
        <p>Private messaging · A BB84 security lab</p>
        <a className="cafe-entry__room-link" href="#join-title">Open a room <ArrowUpRight size={16} aria-hidden="true" /></a>
      </header>

      <div className="cafe-entry__layout">
        <section className="cafe-entry__editorial" aria-labelledby="welcome-title">
          <p className="cafe-entry__edition">A room for two people</p>
          <h1 id="welcome-title">Private conversations,<br /><em>clearly understood.</em></h1>
          <p className="cafe-entry__lead">Send a message. Share a moment. Open the encryption studio to see what happens between the two.</p>
          <div className="cafe-entry__principles">
            <span><LockKeyhole size={17} aria-hidden="true" /> Encrypted in your browser</span>
            <span>Made for conversation <ArrowUpRight size={16} aria-hidden="true" /></span>
          </div>
        </section>

        <section className="cafe-entry__invitation" aria-labelledby="join-title">
          <div className="cafe-entry__slip-heading"><span>Your invitation</span><span>Two seats</span></div>
          {children}
        </section>
      </div>

      <footer className="cafe-entry__footer">
        <span>QKD Chat — a study in private communication.</span>
        <span>BB84 is a software simulation. Chat uses ECDH + AES-256-GCM.</span>
      </footer>
    </main>
  );
}
