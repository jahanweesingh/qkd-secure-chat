# QKD Chat Lab Frontend

Encrypted images/videos are now supported through the composer paperclip.
Files are encrypted locally and uploaded as opaque bytes; a protected descriptor
travels through the existing chat. A fresh encrypted support check blocks older
clients before upload. See [ENCRYPTED_MEDIA.md](../docs/ENCRYPTED_MEDIA.md).

The current visual pass adds a private-exchange welcome illustration, an inset
conversation workspace, visible mobile security/lab labels, a sidebar lab entry,
state-aware protection cards, accessible form validation and a growing composer.
See [FRONTEND_POLISH.md](../docs/FRONTEND_POLISH.md) for verification evidence.

The **BB84 Security Lab** uses a seven-step beginner walkthrough in
`src/SecurityLabWalkthrough.tsx` with scoped `src/security-lab.css`. It reviews
actual completed backend results; it does not fabricate live stage progress.
`ChatProtectionSummary` consumes the existing hook's real encryption state.
Technical algorithms, trace tables, seeds and advanced controls remain in
expandable sections of `App.tsx`. The crypto modules and wire formats are unchanged.
See `../docs/SECURITY_LAB_UPGRADE.md` for the mentor demonstration and verification.

A responsive two-person chat with a shared educational BB84, QBER and Phase 3
post-processing dashboard. The creator backend models preparation,
measurement, basis sifting and QBER, then conditionally demonstrates
reconciliation, leakage accounting, privacy amplification, confirmation and
derivation. The interface receives metrics only. No bit sequence or derived
material reaches the browser, and the Protocol Lab never supplies chat keys.

Phase 4 chat content is encrypted and decrypted in the browsers. Each local
browser profile creates a P-256 ECDH pair with a non-extractable private key,
persists the pair in
IndexedDB when supported, derives directional AES-256-GCM keys with
HKDF-SHA-256, and creates a random 96-bit IV per message. The room backend sees
public keys, metadata and ciphertext envelopes, but not encrypted-message
plaintext. An IndexedDB failure uses a visible page-session key fallback.
When local storage is available, the first peer key ID observed for a
room/profile is remembered across reconnects and room reopens. If storage is
blocked, the pin lasts only for the page. This trust-on-first-use check is not
authenticated identity. If the relay rejects a repeated AES-GCM IV, retry
rotates the local identity and requires the replacement safety code to be
reviewed.

## Local development

```sh
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173` and proxies `/api` and `/ws` to the backend at `http://127.0.0.1:8000`.

## Quality checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

The Dockerfile exposes named `test`, `build`, and `runtime` stages. The runtime Nginx configuration serves the SPA and reverse-proxies same-origin REST and WebSocket traffic to a Compose service named `backend`.

## Backend contract

- `GET /api/health`
- `GET /api/rooms/{room_id}/messages?limit=50`
- `WS /ws/{room_id}?client_id=...&display_name=...`
- Client events: `e2ee_hello`, `encrypted_message`, legacy pre-lock `message`,
  `typing`, `ping`, and `bb84_start`
- Server events: `connected`, `e2ee_public_key`, `encrypted_message`, legacy
  `message`, `presence`, `message_ack`, `typing`, `pong`, `bb84_result`, and
  `error`

The first accepted `e2ee_hello` permanently marks that room
`e2ee_required`. Sending pauses if setup, encryption, authentication or
current-key validation fails; the client never falls back to a plaintext
message in that room. The backend reports relay state, not cryptographic
verification. **Encrypted · Unverified** becomes locally verified only after
the user compares the complete 12-digit safety code through a separate trusted
channel.

The room/profile ECDH key is persistent rather than ephemeral. This build has
no Noise handshake, Double Ratchet, forward secrecy or post-compromise
security. Both Macs must load their own `http://localhost:8080` page so Web
Crypto is available; a direct non-localhost LAN HTTP page is unsupported.

The `bb84_start` command uses bounded server-validated settings. The shared
`bb84_result` contains configuration, aggregate counts, QBER, an educational
decision, a strict `post_processing` report, and a representative 24-row
maximum teaching trace. The Phase 3 view presents four stages: Reconcile,
Reduce exposure, Confirm and Derive. It distinguishes completed, skipped and
failed outcomes, including the case where BB84 sampling passes but estimated
usable material is below the 128 bits required by the teaching pipeline.

The entropy number is labelled as an illustrative asymptotic estimate, not a
finite-key proof. Interception and internal error counts are simulator ground
truth rather than public-channel observations. The response never returns raw
or reconciled bits, privacy-amplified material, Toeplitz seeds, confirmation
tags, HKDF salt or derived bytes. Persistent safety text explains that the
trusted backend models both parties, the demonstration output is discarded,
and messages are neither gated nor encrypted by the Protocol Lab.

For seeded teaching runs, the seed, settings and room/session context are
shared and make the deterministic simulation reconstructible. The absence of
key bytes from the parsed report is a serialization property, not a secrecy
guarantee. Defensive
`confirmation_failed` and `derivation_failed` outcomes represent unexpected
internal disagreement after verified processing rather than normal channel
outcomes.

Rooms accept two distinct client IDs. The current composer limits input to
2,000 characters; the encrypted wire envelope independently caps encoded
plaintext at 4,096 UTF-8 bytes before the 16-byte GCM tag. Legacy pre-lock text
remains limited by the backend configuration. Capacity and identity close
codes are terminal in the UI, while ordinary transport interruptions reconnect
with capped exponential backoff.

See `../docs/PHASE4_E2EE_THREAT_MODEL.md` for the security boundary and
`../docs/PHASE4_SECURITY_UX.md` for exact state and verification language.
