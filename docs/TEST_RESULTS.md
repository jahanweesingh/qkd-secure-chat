# Verification Results

> **Simple encryption demo:** see [SIMPLE_ENCRYPTION_DEMO.md](SIMPLE_ENCRYPTION_DEMO.md)
> for the later 13 November simplification and its verification checkpoint.

> **Latest live presentation (13 November 2026):** see
> [LIVE_SECURITY_VIEW.md](LIVE_SECURITY_VIEW.md) for the implementation and
> verification record. This update adds browser observation traces, the live
> security dialog and actual Eve/no-Eve comparison. Older checkpoints below
> describe their respective releases.

> **Latest encrypted media:** see [ENCRYPTED_MEDIA.md](ENCRYPTED_MEDIA.md) for
> file sharing, capability checks, the minimalist chat changes and current tests.

> **Latest frontend polish:** see [FRONTEND_POLISH.md](FRONTEND_POLISH.md) for
> the historical 77-test checkpoint. Its described screenshots are not included
> in this checkout.
>
> **Security lab upgrade:** see [SECURITY_LAB_UPGRADE.md](SECURITY_LAB_UPGRADE.md)
> for the November 2026 results and updated frontend suite. The September
> checkpoint below is retained as historical evidence; its screenshot names,
> build sizes, interface wording and test counts describe that release.

Verification date: **14 September 2026**

This checkpoint covers the implemented Phase 4 classroom slice: browser-side
P-256 key agreement, directional AES-256-GCM chat encryption, the opaque
FastAPI/SQLite relay, and the independent BB84 and Phase 3 post-processing lab.
All source-level automated checks and deployed runtime checks listed as passed
below completed successfully against this release candidate. The limits in the
final section are part of the result, not optional cautions.

## Automated checks

| Area | Result | Verified coverage |
| --- | --- | --- |
| Backend pytest | **114 passed** | Strict E2EE schemas, durable room lock, current-pair checks, directional IV-reuse rejection, ciphertext persistence, relay behavior, BB84, post-processing and existing API behavior |
| Frontend Vitest/RTL | **55 passed** | Web Crypto vectors and round trips, encrypted wire events, manual verification, tamper, downgrade, persisted peer-key change and IV-recovery fail-closed behavior, strict parsing, chat UX and the independent Protocol Lab |
| TypeScript | **Passed** | Full frontend type check |
| ESLint | **Passed** | Zero warnings allowed |
| npm production dependency audit | **Passed** | 0 known vulnerabilities reported |
| Deployed Docker crypto smoke | **Passed** | Real P-256 ECDH, matching safety codes, directional AES-GCM, two-way authenticated decryption, ciphertext-only history, retry behavior, downgrade rejection and IV-reuse rejection through Nginx |
| Chrome UI smoke | **Passed** | Two isolated browser profiles, two-way encrypted messaging, manual safety-code verification, desktop 1440 by 1000, mobile 390 by 844, no horizontal overflow, readable message contrast and no console warnings or errors |
| Isolated two-backend Docker relay | **Passed** | Key advertisement, opaque encrypted envelope, ciphertext-only persistence, immutable E2EE lock, plaintext-downgrade rejection, reconnect history larger than 8 KiB and the separate Phase 3 result |

The deployed Docker smoke uses Node 22 Web Crypto to produce and consume real
encrypted envelopes through the production Nginx, FastAPI and SQLite stack.
The Chrome UI smoke independently exercises the browser application and its
Web Crypto path using separate Alice and Bob Chrome profiles. The isolated
two-backend relay check uses a standards-shaped synthetic encrypted envelope.
It proves that two production backend processes relay and persist the envelope
without plaintext, including reconnect history that is larger than the inbound
8,192-byte command limit. It does **not** prove browser Web Crypto encryption or
decryption and does not replace the two-browser check.

No new two-physical-Mac Phase 4 run is claimed in this checkpoint. The
localhost-on-each-Mac procedure remains a required hardware acceptance test.
The final production build measured 245.78 kB JavaScript (76.31 kB gzip) and
87.52 kB CSS (18.77 kB gzip).

## Phase 4 backend verification

The backend suite verifies:

- canonical, unpadded base64url fields and strict `e2ee_hello` and
  `encrypted_message` schemas;
- 65-byte SEC1 uncompressed P-256 public keys and SHA-256 public-key IDs;
- the exact raw-byte-ordered pair `key_id` transcript shared with the browser;
- a random-IV envelope shape with a decoded ciphertext length of 17 through
  4,112 bytes, including the 16-byte GCM tag;
- first accepted `e2ee_hello` durably setting `e2ee_required` for the room;
- rejection of plaintext after that lock, including at the persistence layer;
- two distinct current public keys and the current pair ID being required
  before an encrypted message is accepted;
- server injection of `sender_key_id`, so the client cannot choose that stored
  identity field;
- durable IV uniqueness for each
  `(room_id, key_id, sender_key_id, iv)` namespace and the explicit
  `e2ee_iv_reuse` error;
- ciphertext-only encrypted records and history, with no encrypted-message
  `text` field;
- invalidation of a previous pair when a participant leaves or changes keys;
- bounded client-to-relay commands and larger bounded server history frames;
- existing capacity, reconnect, origin, invitation, health and history rules;
  and
- the complete independent BB84 and Phase 3 post-processing behavior.

The server does not receive browser private keys, ECDH shared secrets,
directional AES keys, safety codes or decrypted message text through the
implemented encrypted-message contract.

## Phase 4 frontend verification

The 55 frontend tests verify:

- the exact raw-byte-ordered backend pair-ID vector;
- matching P-256 ECDH and directional HKDF-SHA-256 contexts, AES-256-GCM
  encryption/decryption in both directions and the symmetric 12-digit safety
  code;
- authentication failure after ciphertext or authenticated-metadata tampering;
- bounded failure when the random source repeatedly produces an already-used
  IV under the same send key;
- strict validation of the encrypted payload shape and rejection of using the
  same identity as both peers;
- a browser chat sending only an `encrypted_message` wire envelope and locally
  decrypting an authenticated incoming envelope;
- a visible session-only key-storage warning;
- encrypted-send progress, oversized UTF-8 draft retention, malformed
  encrypted-event rejection and live plaintext-downgrade rejection;
- explicit safety-code verification and clearing, changed-peer-key send
  blocking, detection after leaving and reopening the room, and deliberate
  acceptance as encrypted but unverified;
- rotation of the local identity after an IV-reuse rejection, followed by a
  required review of the replacement safety code;
- fail-closed handling of tampered ciphertext with no partial plaintext shown;
- an explicit unavailable-key state for encrypted history that cannot be
  decrypted, rather than an indefinite decrypting state;
- onboarding validation, local and routed room behavior, connection state,
  terminal room-capacity behavior and room-code copying;
- strict Protocol Lab parsing, result states and the boundary between the
  simulation and live chat encryption; and
- keyboard focus trapping and restoration for the Protocol Lab dialog.

Non-extractable private-key creation, IndexedDB reuse, the non-secure
non-loopback origin guard, disconnect behavior and CSS layout are implemented,
but they are not each represented by a dedicated assertion in the 55-test
frontend count. The persistence, origin, disconnect and identity-refresh cases
remain explicit manual security-negative checks. Desktop/mobile layout and the
deployed two-browser flow were covered by the current Chrome acceptance smoke
described below.

The UI deliberately distinguishes transport acceptance from security:
`message_ack` means the relay accepted and persisted an envelope. It does not
prove peer delivery, decryption or identity verification.

## Deployed browser acceptance

The final Docker build was opened in two isolated Chrome browser profiles at
`http://127.0.0.1:8080`. The passing browser smoke verified:

- both clients reached **Encrypted · Unverified** using real browser Web
  Crypto;
- the complete grouped 12-digit safety code matched in both clients;
- one client explicitly recorded **Encrypted · Verified on this browser**;
- authenticated messages decrypted in both directions;
- the sender UI used **Accepted for encrypted relay**, rather than claiming
  delivery;
- the security drawer displayed the P-256, ECDH, HKDF-SHA-256 and AES-256-GCM
  path plus the active-relay and visible-metadata warning;
- the desktop and 390 by 844 layouts had no document-level horizontal
  overflow;
- own-message text had an opaque dark-green surface with white text; and
- neither client emitted a console warning or uncaught exception.

The historical report says five screenshots were saved under
`artifacts/ui-smoke/`, but that directory is not included in this checkout.
They are therefore unavailable as current visual regression evidence here.
The report describes a localhost browser run with separate storage profiles;
that does not substitute for physical two-Mac LAN acceptance.

The final Compose stack was also checked in its default configuration. Both
services reported healthy, the frontend was bound only to
`127.0.0.1:8080`, `GET /api/health` returned an operational database, and
`GET /api/network` correctly reported localhost mode with no advertised LAN
host. LAN sharing still requires running `scripts/start_lan.sh` separately on
each Mac.

## Isolated production-relay verification

Two independently configured production backend containers were connected on
an isolated Docker network. The passing relay test verified:

- public-key advertisements crossing the relay boundary;
- an accepted opaque `AES-256-GCM` envelope with the server-derived sender key
  ID;
- identical ciphertext metadata on both backend paths;
- ciphertext-only REST/SQLite history with no message `text` value;
- an immutable `e2ee_required` room lock and rejection of a later plaintext
  message;
- successful reconnect delivery of a bounded history frame larger than 8 KiB;
- the creator remaining authoritative for the separate BB84/Phase 3 result;
  and
- removal of the temporary containers and isolated network after the run.

This is backend relay evidence. Because the encrypted envelope is synthetic,
it makes no claim that a real browser derived, authenticated or decrypted its
contents.

## Independent Protocol Lab verification

The protocol suites continue to verify:

- BB84 basis sifting, QBER bounds, repeatable public teaching seeds and the
  expected statistical trend toward 25 percent QBER under full
  intercept-resend;
- a private one-use candidate transcript and a public trace capped at 24 rows
  without undisclosed raw bit values;
- bounded Cascade-inspired reconciliation and exact parity leakage;
- the illustrative estimate
  `floor(n * (1 - h2(min(Q, 0.5))) - leaked_bits - 32)`, clamped from zero
  through `n`;
- separate accepted, skipped, reconciliation-failed, insufficient-entropy,
  confirmation-failed and derivation-failed reports;
- 128-bit Toeplitz privacy amplification, internal truncated HMAC-SHA-256
  confirmation and a context-bound 256-bit-sized HKDF output;
- recursive absence of candidate bits, reconciled bits, Toeplitz seeds,
  privacy-amplified values, confirmation tags, HKDF salts and derived bytes
  from the public payload; and
- identical ephemeral `bb84_result` events for both participants with no
  reconnect replay or persistence.

The largest compact result in the bounded configuration grid was previously
measured at **4,448 bytes**, which is **3,744 bytes** below the 8,192-byte
client-command relay limit. This protocol result measurement is separate from
the larger encrypted history frame exercised by the Phase 4 relay test.

## Required manual two-Mac acceptance test

Before presenting the LAN workflow as demonstrated on the target hardware:

1. Serve the application locally on both Macs and open
   `http://localhost:8080` on each Mac.
2. Join one invitation through the LAN relay. Do not open the creator's LAN IP
   directly in the second browser.
3. Wait for **Encrypted · Unverified** on both sides.
4. Compare all 12 safety-code digits through an independent channel, then mark
   the current pair verified in both browsers.
5. Exchange messages in both directions and confirm successful local
   decryption.
6. Inspect REST history and SQLite to confirm encrypted rows contain IV,
   ciphertext and key metadata but no plaintext field.
7. Refresh both sides and verify the expected IndexedDB identity/history
   behavior.
8. Change one browser identity and confirm sending pauses, prior verification
   is cleared and the new pair requires a new comparison.

Record the two machines, browsers, room code, result and date when this check is
performed. See [LAN_SETUP.md](LAN_SETUP.md) for the complete procedure.

## Security interpretation

- Chat content is encrypted only after the two browsers establish the current
  Phase 4 pair. Room code, display names, participant identifiers, key IDs,
  timing, presence, sizes, IVs and ciphertext remain visible to the relay.
- **Encrypted · Unverified** is susceptible to an active relay substituting
  public keys. Only an out-of-band comparison of the full safety code provides
  the implemented manual key check.
- A local **Verified on this browser** decision authenticates the compared key
  pair, not a legal identity, account or uncompromised device.
- Persistent P-256 identities improve continuity but provide no Double Ratchet,
  forward secrecy or post-compromise security. Compromise of a persistent
  private key can expose messages protected for that pair.
- Random 96-bit IV generation, client duplicate checks and the backend unique
  index reduce accidental reuse; they are not a formal persistent monotonic
  nonce allocator or a proof of a per-key usage bound.
- Direct LAN HTTP is unsupported because it is not a trusted browser context.
  Use localhost on each Mac or provision reviewed HTTPS.
- The BB84 and Phase 3 pipeline is a creator-backend educational simulation.
  Its output never supplies, unlocks, verifies or changes Phase 4 chat keys.
- `simulation_only`, `chat_encryption_active: false`,
  `key_material_exposed: false` and `key_used_for_chat: false` describe the
  Protocol Lab material, not the separate live browser encryption state.

This is a classroom E2EE prototype for trusted-device, controlled-network
demonstrations. It is not a production secure messenger.
