# Project Phase Status

## Current status — 23 November 2026

The application supports the original ECDH-only encrypted chat and an opt-in
endpoint-owned BB84 + ECDH hybrid mode. Alice and Bob independently simulate
BB84 in their browsers; protected WebSocket relay messages carry the protocol
exchange. Only matching contributions with successful mutual confirmation can
activate a hybrid epoch. The room-hosted BB84 teaching report remains a
separate educational run. This is a software simulation, provides no security
independent of ECDH, and is not physical QKD. See the current
[protocol and implementation record](BB84_AES_INTEGRATION_PLAN.md).

Notes below labelled by earlier dates record the project state at those dates;
they are historical and are superseded by this status and the current protocol
record.

> **Simpler dashboard (13 November 2026):** the encryption demo now has a
> compact message → ciphertext → recovered-text view and a separate local
> exercise with inspectable, disposable ECDH/HKDF/AES keys. Live chat can show
> the actual public envelope and backend acknowledgement. See
> [SIMPLE_ENCRYPTION_DEMO.md](SIMPLE_ENCRYPTION_DEMO.md). This does not connect
> BB84 to chat or make production chat keys exportable.

> **Live presentation update (13 November 2026):** the chat header now opens a
> live, privacy-filtered view of browser encryption and decryption observations.
> The lab adds a comparison of two actual backend runs, with and without Eve,
> and a recorded-transmission illustration. No cryptographic or wire-format
> changes were made. See [LIVE_SECURITY_VIEW.md](LIVE_SECURITY_VIEW.md) and
> [PANEL_DEMO.md](PANEL_DEMO.md). BB84 remains separate from AES chat keys.

> **Encrypted media update (12 November 2026):** images and videos now use a
> fresh browser AES-GCM file key, opaque HTTP storage and a key-bearing descriptor
> protected by the existing chat envelope. See [ENCRYPTED_MEDIA.md](ENCRYPTED_MEDIA.md)
> for the capability gate, key lifecycle, quotas and limitations. Text key
> establishment and the independent BB84 simulation remain unchanged.

## BB84 modes

The **BB84 Security Lab** presents the endpoint-owned exchange and the separate
room-hosted teaching report. Endpoint progress, QBER, contribution, mutual
confirmation and epoch status come from browser runtime state. A lab report or
a BB84 run that did not activate a confirmed epoch cannot change chat keys.
Advanced details and teaching results do not expose secret key bytes.

## Current implementation

This repository contains the first working Phase 4 classroom E2EE slice. It
retains the two-person chat, dual-Mac LAN relay, shared BB84/QBER experiment and
Phase 3 post-processing model, then adds browser-to-browser encrypted chat.

The chat path includes:

- non-extractable P-256 ECDH private keys created in each browser;
- IndexedDB persistence scoped to the room/profile, with a visible page-session
  fallback when persistence is unavailable;
- strict `e2ee-v1` public-key advertisements;
- ECDH-only fallback plus optional BB84 + ECDH hybrid HKDF-SHA-256 directional
  AES-256-GCM keys, activated only after mutual confirmation;
- fresh random 96-bit IVs, a local per-send-key duplicate check and a durable
  backend per-room, pair and sender-key uniqueness constraint;
- AES-GCM authenticated additional data for room, sender, message and key
  context;
- a locally derived 12-digit manual-comparison code;
- a locally remembered first peer-key ID that detects later replacement for
  the same room/profile across reconnects and room reopens;
- ciphertext-only SQLite rows for encrypted messages; and
- an immutable `e2ee_required` room lock that rejects plaintext fallback.

The backend validates and relays public keys, opaque message envelopes and
protected BB84 control envelopes. It does not perform ECDH or AES-GCM and does
not receive BB84 contributions, browser private keys, derived AES keys or
encrypted-message plaintext.

## How to run Phase 4 on two Macs

Both Macs run their own project copy and open `http://localhost:8080`. The
joining Mac's backend relays to the creator backend over the existing private
LAN route. The browser application must not be opened directly from
`http://<other-Mac-LAN-IP>:8080`; that is not a supported secure-context client
path.

The LAN backend hop is not TLS-protected in this classroom build. Message
content is already encrypted before it reaches that hop, but room, identity,
public-key, timing and size metadata remain visible. Use only on a trusted
private network.

## Encryption and verification meaning

The browser states have distinct meanings in both ECDH-only and confirmed
hybrid modes:

- **Setting up / Waiting for partner:** no send key is ready, so sending is
  disabled.
- **Encrypted · Unverified:** message content is encrypted to the currently
  presented peer key, but an active man-in-the-middle has not been ruled out.
- **Encrypted · Verified on this browser:** this user recorded that the full
  12-digit code matched through another trusted channel.
- **Key changed:** prior verification no longer applies and sending pauses.
- **Failed:** the room stays encryption-required and no plaintext fallback is
  allowed.

The verification record is local and keyed by room and current public-key pair.
The backend never reports a participant as verified. A matching code confirms
the current browser key pair, not a legal name, account, honest person or
uncompromised device.

## Room and history behavior

The first accepted `e2ee_hello` durably activates `e2ee_required` for the room.
WebSocket validation and a SQLite trigger both reject later plaintext message
insertion. Encrypted records contain the version, algorithm, pair key ID,
sender key ID, IV and ciphertext/tag, never a plaintext `text` field.

If a room had plaintext rows before the lock, API history marks those rows
`legacy_plaintext: true`. The UI must not relabel them as encrypted.

`message_ack` means accepted for relay and persistence. It does not prove peer
delivery or successful browser decryption.

## Key lifecycle

The identity scope contains the protocol version, room and trimmed,
locale-lowercased local display name. When IndexedDB can store the key pair,
including its non-extractable private `CryptoKey`, the same browser profile can
derive the same room context after refresh. If storage is unavailable, the key
lasts only for the page session; refreshing changes the key and safety code and
may leave earlier ciphertext unavailable.

When local storage is available, the browser also remembers the first valid
peer key ID for that room/profile. A later mismatch pauses sending even after
the user leaves and reopens the room. If storage is blocked, the pin lasts only
for the page. Accepting the replacement updates this local trust-on-first-use
record but leaves the pair unverified until the new safety code is compared.
The record is continuity evidence, not authentication of the first key or a
real-world person.

An `e2ee_iv_reuse` response keeps sending paused. Retrying then creates and
stores a new local identity, discards the old derived contexts and requires the
new safety code to be reviewed. This is incident recovery, not forward secrecy
or a ratchet.

`extractable: false` prevents normal Web Crypto export. It is not a
hardware-storage or endpoint-security guarantee. Same-origin malicious code,
a compromised browser extension or an attacker controlling the Mac can still
use the key and read plaintext.

## Cryptographic limits

This first slice uses a persistent P-256 ECDH key for each room/profile. It has
no ephemeral DH handshake, signed identity key, Noise protocol, X3DH or Double
Ratchet. It therefore does not claim forward secrecy, post-compromise security
or automatically authenticated identity.

The 12-digit code is a manual classroom verification mechanism with about 40
bits of possible displayed values. Users must compare all digits through a
different trusted channel. Until then, the active relay can substitute public
keys and perform a man-in-the-middle attack.

The words AES-256 describe the AES key size. They are not a claim that the
complete system provides 256 bits of security.

## Protocol Lab remains independent

Phase 3 continues to model:

- bounded reconciliation and exact parity-leakage accounting;
- illustrative asymptotic binary-entropy estimation;
- Toeplitz universal-hash privacy amplification;
- internal HMAC-SHA-256 confirmation; and
- context-bound HKDF-SHA-256 demonstration output that is discarded.

That room-hosted teaching path still runs as a classical simulation inside the
creator backend. It is not physical QKD or a finite-key proof. Its output never
supplies Phase 4 browser keys or changes chat state. The separate
endpoint-owned browser protocol may contribute to a hybrid chat epoch after
mutual confirmation.

## Deliberately not implemented

- authenticated accounts, certificates or signed device identities;
- automatic authenticated key exchange;
- ephemeral sessions, a Double Ratchet, forward secrecy or post-compromise
  security;
- production HTTPS/WSS on the LAN relay;
- metadata hiding, anonymous routing or traffic padding;
- authenticated peer delivery/decryption receipts;
- multi-device key synchronization or recovery;
- readable recovery of ciphertext after browser-key loss;
- physical quantum transmission or hardware integration; or
- a formal cryptographic proof, security certification or independent audit.

## Safety statement

This is a classroom implementation for academic demonstration and controlled
LAN testing. It materially improves content confidentiality compared with the
Phase 3 plaintext chat, but it is not a production secure messenger. Compare
the safety code before treating the peer key as authenticated. Do not use the
build for confidential or high-risk communication.

See [PHASE4_E2EE_THREAT_MODEL.md](PHASE4_E2EE_THREAT_MODEL.md) and
[PHASE4_SECURITY_UX.md](PHASE4_SECURITY_UX.md) for the precise boundary and
honest interface language.
