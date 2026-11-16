# Security Status

This repository is an academic Phase 4 classroom prototype. It now encrypts
chat content between two browser clients, but it is not a production secure
messenger.

## What protects chat content

- Each browser holds a non-extractable P-256 ECDH private `CryptoKey`.
- HKDF-SHA-256 derives separate directional AES-256-GCM keys.
- Every message uses a random 96-bit IV and a 128-bit GCM tag.
- Clear envelope context is authenticated as AES-GCM additional data.
- The backend persists and relays only ciphertext envelopes for encrypted
  messages.
- A durable `e2ee_required` room lock rejects plaintext fallback.
- A 12-digit code lets users manually compare the current browser key pair.

The private ECDH and derived AES keys are not sent to the backend or stored in
SQLite. A backend acknowledgement means accepted for relay, not decrypted by
the peer.

## Manual verification is required

P-256 ECDH establishes a shared secret with the public key that was presented.
It does not automatically prove who supplied that key. Before the complete
12-digit code is compared through a separate trusted channel, an active relay
or network attacker may substitute keys and perform a man-in-the-middle attack.

The UI therefore distinguishes **Encrypted · Unverified** from
**Encrypted · Verified on this browser**. Verification is a local record. It
confirms the current public-key pair, not a legal name, account or safe device.
A changed key makes that record inapplicable and pauses sending. The first peer
key ID seen for each room/profile is also remembered in local browser storage
when available, so a replacement is detected after reconnect or room reopen.
If that storage is blocked, the pin lasts only for the page. This is
trust-on-first-use continuity only; it does not authenticate the first key.

## Key storage limits

The browser attempts to persist the non-extractable room/profile key pair in
IndexedDB. If this is unavailable, it uses a page-session key and must show
**Key lasts for this tab**. Refreshing then changes the key and safety code and
may make earlier ciphertext unavailable.

Non-extractable does not mean hardware-backed or inaccessible to hostile code.
A compromised local application, same-origin script, browser extension,
browser profile, operating system or conversation endpoint can read plaintext
or use the key.

## No forward secrecy claim

This slice uses persistent P-256 ECDH keys. It does not implement Noise, X3DH,
ephemeral session DH, a Double Ratchet or per-message ratcheting. Compromise of
a persistent private key plus recorded public context may expose older
ciphertext. Do not describe Phase 4 as forward secret or post-compromise
secure.

## Localhost and LAN boundary

Both Macs must run their own project copy and open
`http://localhost:8080`. Browsers treat localhost as a potentially trustworthy
context for Web Crypto. The joining backend uses the existing LAN relay to
reach the creator backend.

Do not use `http://<other-Mac-LAN-IP>:8080` as the browser client. A plain LAN
HTTP page is not a supported secure context and could have its JavaScript
replaced in transit.

The backend-to-backend LAN hop does not use TLS in this classroom slice.
Encrypted message content remains ciphertext on that hop, but public keys,
self-entered names, room data, timing, presence and ciphertext sizes are
visible. Before public deployment, add HTTPS/WSS, authenticated client
distribution, abuse protection, monitoring that excludes secrets and an
independent security review.

## AES-GCM safety rules

AES-GCM IV uniqueness is mandatory. The browser tracks IVs per active send key
and rejects a duplicate before encryption. The backend independently enforces
the durable directional tuple `(room_id, key_id, sender_key_id, iv)` and emits
`e2ee_iv_reuse` on conflict. After that error, sending remains paused. A user
retry rotates the local room/profile identity, clears the old message-key
contexts and requires the replacement safety code to be reviewed.

Authentication failure returns no partial plaintext. A message with a changed
ciphertext, tag, IV or authenticated envelope field is not displayed as normal
chat and pauses sending. Encryption failures never cause automatic plaintext
fallback.

## Protocol Lab boundary

The BB84, QBER, reconciliation, Toeplitz, HMAC and HKDF views remain an
educational classical simulation in the creator backend. They do not provide a
physical quantum channel, finite-key proof or participant authentication.
Their temporary demonstration material is discarded and is never used for
Phase 4 chat encryption.

Seeded Protocol Lab runs remain deterministic and reconstructible. The
`key_material_exposed: false` report field means only that key bytes were not
serialized in the report; it is not a secrecy guarantee.

## Not protected

- room, identity, public-key, timing, presence and size metadata;
- availability against a malicious relay or network;
- compromised Macs, browsers, extensions or local application code;
- malicious conversation partners, screenshots or copied text;
- authenticated accounts or real-world identities;
- old ciphertext after unrecoverable browser-key loss;
- forward secrecy or post-compromise security; and
- public internet deployment.

Use this build for academic demonstration and controlled private-LAN testing
only. Do not send confidential or high-risk information. Report implementation
vulnerabilities privately to the project maintainers.

See [docs/PHASE4_E2EE_THREAT_MODEL.md](docs/PHASE4_E2EE_THREAT_MODEL.md) for the
full threat model and [docs/PHASE4_SECURITY_UX.md](docs/PHASE4_SECURITY_UX.md)
for required user-facing language.
