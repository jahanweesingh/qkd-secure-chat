# QKD Chat Lab

**Free public hosting:** the prepared [Render deployment](docs/FREE_HOSTING.md)
serves the frontend, API and WebSockets at one HTTPS address. Both participants
open that same address and share an online room code. The Free service has
temporary storage and can sleep; it is intended for demonstrations. The local
Docker and two-Mac LAN paths below remain available.

**A simple encryption example:** open **Encryption demo**, type **hi**, then
choose **Encrypt & decrypt**. See actual ciphertext, recovered text and fresh
visible learning keys. Switch to **Live chat** to inspect real chat envelopes
and server acknowledgements. Learning keys are separate from protected chat
keys. See [the simple demo guide](docs/SIMPLE_ENCRYPTION_DEMO.md).

**Images and short videos:** select the paperclip in a ready encrypted room,
preview your file, then choose **Send file** (up to 10 MB). The recipient opens
and decrypts it locally. The header's encryption badge opens device verification
and technical details. Refresh both browser profiles before the demo.
See [encrypted media design and limits](docs/ENCRYPTED_MEDIA.md).

**Presenting to your project panel:** follow the [seven-minute demonstration
guide](docs/PANEL_DEMO.md) for live encryption observations, a verified BB84
comparison with and without Eve, and a scoped Wireshark or DevTools walkthrough.
The guide distinguishes simulated interception from passive packet capture and
includes beginner-friendly answers to common panel questions.

## BB84 Security Lab upgrade

The lab now explains the experiment in seven plain-language steps, with Alice,
Bob and Eve, actual counts and encoding choices, and a clear completed/stopped
outcome. Select **BB84 lab** in the chat, then **Start BB84 Experiment**.
The server returns one completed report; the step controls review that report
at your pace, rather than pretending to show live simulation progress.
Advanced settings and the original technical diagnostics remain expandable.

**Chat still uses ECDH and AES-256-GCM. BB84 is not connected to its key
derivation.** The lab's chat status now comes from the actual browser encryption
state, not a fixed “active” label. A passed sample can still fail the later
key-preparation checks. The BB84 lab displays no private bits or key values;
the separate learning exercise intentionally displays its disposable keys.

Read [the integration design decision](docs/BB84_AES_INTEGRATION_PLAN.md) for
the current key lifecycle, why server-owned BB84 output is unsuitable for the
requested endpoint-owned design, and the versioned protocol needed next.
See [the upgrade delivery report](docs/SECURITY_LAB_UPGRADE.md) for the change
list, mentor walkthrough and actual verification results.

QKD Chat Lab is the working **Phase 4 classroom E2EE slice** of the BB84-QKD
Based Secure Chat Application described in the supplied project report. It
retains the two-person chat, dual-Mac LAN relay, shared BB84/QBER experiment and
Phase 3 post-processing model, then adds P-256 browser key agreement and
AES-256-GCM encrypted message envelopes.

> **Security status:** message content is encrypted and decrypted in the two
> browsers. The backend relays and stores ciphertext-only Phase 4 message
> envelopes. The public-key exchange is not automatically authenticated, so
> **Encrypted · Unverified** remains susceptible to an active
> man-in-the-middle. Compare the complete 12-digit code through another trusted
> channel. This slice has no Double Ratchet, forward secrecy, authenticated
> accounts. The local stack uses HTTP on localhost; the Render deployment adds
> managed HTTPS/WSS. Use it only for classroom and controlled demonstrations.
>
> The BB84 and post-processing path remains an independent server-side teaching
> simulation. It never supplies chat keys. A seeded run is reconstructible;
> `key_material_exposed: false` means only that key bytes are omitted from its
> JSON report.

## Phase 4 encrypted chat

- Each browser creates a non-extractable P-256 ECDH private key.
- The room/profile key is stored in IndexedDB when supported; otherwise a
  visible session-only fallback changes after refresh.
- HKDF-SHA-256 derives different low-key-to-high-key and high-key-to-low-key
  AES-256-GCM keys.
- Each message uses a random 96-bit IV, a 128-bit tag and authenticated room,
  sender, message and key context.
- The backend stores `iv` and ciphertext/tag, never encrypted-message
  plaintext.
- The first key advertisement durably activates an immutable `e2ee_required`
  room lock. Plaintext cannot be used as a failure fallback.
- The 12-digit safety code is calculated in each browser from both public keys,
  room context and the ECDH shared secret. Only a local user action can mark it
  verified.
- When local storage is available, the first peer key seen for a room/profile
  is remembered across reconnect and room reopen. A different peer key pauses
  sending. This is trust-on-first-use continuity, not authenticated identity.
- If the relay detects an AES-GCM IV reuse, retry rotates this browser's
  room/profile identity and requires the new safety code to be reviewed.

The words AES-256 describe the AES key size, not a 256-bit security claim. The
persistent P-256 key design has no forward secrecy or post-compromise security.
See [docs/PHASE4_E2EE_THREAT_MODEL.md](docs/PHASE4_E2EE_THREAT_MODEL.md) for the
precise boundary.

## Protocol Lab: Phase 3 post-processing

The dashboard models Alice and Bob choosing independent Z or X bases,
optional intercept-resend activity, a simplified independent outcome-flip
noise model, basis sifting, random sample disclosure and QBER calculation.
Experiment controls are deliberately bounded:

- qubit count: 128, 256, 512 or 1024;
- noise probability: 0 to 0.25;
- intercept probability: 0 to 1;
- sample ratio: 0.1 to 0.5;
- QBER threshold: 0.01 to 0.25;
- optional integer seed for repeatable classroom experiments.

Results show transmitted, intercepted, sifted, sampled, mismatched and retained
counts, the observed QBER, and an accepted or aborted policy decision. An
accepted run continues through four teaching stages:

1. **Reconcile:** a bounded Cascade-inspired parity model attempts to correct
   Bob's retained candidate sequence and counts the disclosed parity bits.
2. **Reduce exposure:** an illustrative asymptotic binary-entropy estimate
   subtracts reconciliation leakage and a 32-bit security margin. If at least
   128 estimated bits remain, a Toeplitz universal hash models privacy
   amplification.
3. **Confirm:** independently calculated, truncated HMAC-SHA-256 tags are
   compared in constant time inside the simulator.
4. **Derive:** HKDF-SHA-256 expands the 128-bit privacy-amplified input into a
   256-bit demonstration output bound to the protocol version, room and
   session, then immediately discards it. This output length does not increase
   the entropy beyond the 128-bit input.

A BB84-accepted run can still stop with `reconciliation_failed` or
`insufficient_entropy`. HKDF cannot create missing entropy. The defensive
`confirmation_failed` and `derivation_failed` reasons represent unexpected
internal disagreement after verified processing, not normal channel outcomes.
The calculation is an educational asymptotic estimate, not a finite-key
security proof.

The shared result includes only aggregate processing metrics and a
representative BB84 trace of at most 24 rows. It never exposes raw or
reconciled bits, Toeplitz seed material, confirmation tags, HKDF salt or
derived bytes. A completed result does not encrypt, unlock or otherwise change
the independent Phase 4 chat keys.

## Run it on localhost

You only need Docker Desktop or another Docker Compose-compatible runtime.

```bash
cp .env.example .env
docker compose up --build -d
```

Open [http://localhost:8080](http://localhost:8080), then:

1. Enter your name and create a room.
2. Copy the room code.
3. Open another browser or private window, choose **Join room**, and enter that
   code with a different name.
4. Wait for **Encrypted · Unverified** in both browsers. Compare the complete
   12-digit safety code through a separate trusted channel, then mark it
   verified in each browser.
5. Send messages in both directions. The browsers encrypt and decrypt locally;
   the backend stores ciphertext envelopes.
6. Refresh either window. Once the same peer key is advertised again, a
   persisted IndexedDB identity can decrypt matching history. A browser using
   the visible session-only fallback cannot recover that identity after
   refresh.
7. Open **Protocol Lab** and run a shared experiment to inspect the BB84 and
   Phase 3 post-processing results in both windows.

## Chat between two Macs

Both Macs can now run their own Docker copy and keep their browser on
`http://localhost:8080`. A LAN invitation code contains the creator Mac's
private hotspot address, so the joining Mac's backend can relay the connection
to the correct room automatically.

Connect both Macs to the same trusted hotspot, Wi-Fi, or Ethernet network. On
**each Mac**, run:

```bash
./scripts/start_lan.sh
```

The helper detects the private LAN address, creates an untracked `.env.lan`
with the correct address, and starts Docker. Each person then opens
[http://localhost:8080](http://localhost:8080) on their own Mac.

Keep the page itself on `localhost` on both Macs. Opening the creator's direct
LAN URL, such as `http://192.168.x.x:8080`, is unsupported because Web Crypto
is not available to this application in an insecure non-localhost HTTP
context. The joining backend, not the browser page, relays to the creator over
the private LAN.

One person selects **Create room** and copies the complete invitation code,
which looks like `QKD-0123456789ABCDEF-30AG09A`. The other participant selects
**Join room** in their own local app and pastes that exact code. No IP address
needs to be entered. The creator Mac remains the room owner and stores the
authoritative ciphertext history. Once both browsers show
**Encrypted · Unverified**, compare the complete 12-digit safety code through
a separate trusted channel before marking the peer key verified.

Both Macs must be on the same trusted, non-guest network. Full instructions and
firewall troubleshooting are in [docs/LAN_SETUP.md](docs/LAN_SETUP.md).

If the launcher reports `192.0.0.2` with CLAT/NAT64, the current network is
IPv6-only and does not provide a peer-reachable IPv4 address. Do not force that
address with `--ip`. Connect both Macs to a trusted Wi-Fi or Ethernet network
that gives this host a `10.x`, `192.168.x`, or `172.16-31.x` address, then rerun
the launcher.

Stop the application without deleting its message history:

```bash
docker compose --env-file .env.lan down
```

To remove the local history as well, use
`docker compose --env-file .env.lan down -v`. That command deletes the
project's Docker volume and cannot be undone.

## Verify the project

Run all unit, integration and production-build checks inside Docker:

```bash
docker compose --profile test build
docker compose --profile test run --rm backend-test
docker compose --profile test run --rm frontend-test
docker compose --profile test run --rm smoke
```

The end-to-end smoke test reaches the application through Nginx and verifies:

- backend and database health;
- two live WebSocket participants;
- real P-256 ECDH and matching 12-digit safety codes;
- directional HKDF-SHA-256 and AES-256-GCM encryption/decryption in both directions;
- ciphertext-only broadcasts, acknowledgements and SQLite history;
- encrypted retries plus plaintext-downgrade and IV-reuse rejection;
- typing and ping/pong events;
- rejection of a third participant.

The separate `scripts/browser_ui_smoke.mjs` acceptance helper can drive two
isolated Chrome profiles and records desktop and mobile acceptance screenshots
under `artifacts/ui-smoke/`.

The backend suite's Phase 4 coverage
includes strict key and envelope validation, durable room locking, current-pair
checks, directional IV-reuse rejection, ciphertext persistence and relay
behaviour. The isolated two-backend Docker relay smoke adds public-key
advertisement, an opaque encrypted envelope, ciphertext-only persistence and
plaintext-downgrade rejection across the relay boundary. The protocol suites
also verify seeded repeatability, ideal-channel
behaviour, the statistical intercept-resend trend, QBER decisions,
reconciliation and leakage accounting, Toeplitz hashing, illustrative entropy
outcomes, HMAC confirmation, context-bound HKDF, secret-free output,
simultaneous-run rejection, input bounds and room-wide `bb84_result` delivery.
The frontend suite now contains 207 tests covering browser
cryptography, encrypted chat states, manual verification, fail-closed behavior,
the strict API parser and the independent Protocol Lab.
`docs/TEST_RESULTS.md` records the current source-level, Docker runtime and
two-browser verification results.

See [docs/TESTING.md](docs/TESTING.md) for the complete procedure and
[docs/TEST_RESULTS.md](docs/TEST_RESULTS.md) for the verified handoff results.

## What is included

```text
frontend/              React, TypeScript and Vite interface
backend/               FastAPI ciphertext relay, BB84 simulator and Phase 3 processor
scripts/               Docker and dual-host end-to-end smoke tests
docs/                  API, architecture, requirements and phase status
docker-compose.yml     One-command local stack
```

The browser is served by Nginx on port `8080`. Nginx forwards `/api` and `/ws`
to the private FastAPI container. SQLite data is held in the named Docker
volume `bb84-secure-chat_chat-data`.

## Configuration

Copy `.env.example` to `.env` and change values only when needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEPLOYMENT_MODE` | `local` | `hosted` requires explicit origins and disables LAN relay |
| `APP_PORT` | `8080` | Host port used by the local web interface; hosted startup uses Render's `PORT` |
| `BIND_ADDRESS` | `127.0.0.1` | Local-only bind; LAN helper changes it to `0.0.0.0` |
| `LAN_ADVERTISE_IP` | unset | RFC1918 address encoded into LAN invitation codes |
| `DATABASE_PATH` | `/data/chat.db` | SQLite path inside the backend container |
| `ALLOWED_ORIGINS` | localhost origins | Allowed browser WebSocket/HTTP origins |
| `MAX_MESSAGE_LENGTH` | `2000` | Legacy plaintext character cap; Phase 4 envelope limit is fixed at 4,096 UTF-8 bytes and the current composer remains 2,000 characters |
| `HISTORY_LIMIT` | `100` | Maximum history records returned |

If port 8080 is busy, set `APP_PORT=8090` in `.env` and include the matching
origin, such as `http://localhost:8090`, in `ALLOWED_ORIGINS`.

## Local development without Docker

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
DATABASE_PATH=./data/chat.db ALLOWED_ORIGINS=http://localhost:5173 \
  uvicorn app.main:app --reload
```

Frontend, in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Vite opens the development interface at `http://localhost:5173` and proxies
API and WebSocket traffic to the backend on port 8000.

## Design decisions

- Rooms are intentionally limited to two distinct live client IDs.
- Self-entered display names are not authenticated accounts. Each browser uses
  a P-256 key scoped to the room and normalized display-name profile.
- Messages are acknowledged with a client-generated ID, which lets the UI
  reconcile optimistic sends with stored records without duplicating them.
- Presence and typing state are ephemeral. Local Docker history uses a persistent
  volume; Render Free history and encrypted uploads are temporary.
- A LAN invitation has 80 random bits plus the creator's encoded private IPv4
  address. The joining backend decodes only RFC1918 targets and relays one hop.
- The creator backend is authoritative for that room; peer databases are not
  merged and the joining Mac is never promoted automatically. For Phase 4
  messages, this authority stores and relays ciphertext envelopes rather than
  message plaintext.
- The first accepted browser public-key advertisement durably locks the room
  to `e2ee_required`. Encryption failure pauses sending; it never downgrades
  the same room to plaintext.
- Peer verification is local. The relay cannot generate or approve the
  12-digit safety code, and a server acknowledgement does not prove that the
  other browser decrypted a message.
- When available, local browser storage remembers the first peer key ID for
  each room/profile. A later mismatch is a trust-on-first-use continuity
  warning, not proof of an attack or of the peer's real-world identity.
- A non-extractable P-256 identity key is persisted in IndexedDB when possible,
  with a visible memory-only fallback. This is software key isolation, not a
  hardware-backed guarantee.
- The current static room/profile key has no Double Ratchet, forward secrecy or
  post-compromise security. A changed peer key pauses sends and requires a new
  safety-code comparison.
- A repeated-IV rejection leaves sending paused. Retrying rotates the local
  room/profile identity, clears the active contexts and requires the replacement
  safety code to be reviewed before sending resumes.
- The creator backend is authoritative for the BB84 run and educational
  post-processing. Results are live and ephemeral; they are not stored in
  SQLite or replayed to a later participant.
- Private candidate sequences exist only during processing inside that trusted
  backend. Public serialization uses a fixed secret-free report, and derived
  demonstration material is discarded after its metrics are produced.
- The optional seed is for reproducible teaching runs, not cryptographic
  randomness. The public seed, settings and room/session context make the
  deterministic run reconstructible, so its candidate and derived values must
  be treated as non-secret. The entropy estimate is illustrative rather than a
  finite-key proof.
- `key_material_exposed: false` records that no key bytes were serialized in
  the report. It does not claim that a seeded run is secret or that the wider
  system provides key confidentiality.
- Phase 4 chat E2EE remains completely separate from the BB84 teaching run.
  Phase 3 does not provide physical QKD, browser key ownership or chat keys.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/API.md](docs/API.md),
[docs/PHASE4_E2EE_THREAT_MODEL.md](docs/PHASE4_E2EE_THREAT_MODEL.md),
[docs/PHASE4_SECURITY_UX.md](docs/PHASE4_SECURITY_UX.md), and
[SECURITY.md](SECURITY.md) before extending the project.

## Troubleshooting

- **Docker cannot connect:** start Docker Desktop and wait until its engine is
  ready, then rerun the command.
- **Port already in use:** change `APP_PORT` in `.env` and update
  `ALLOWED_ORIGINS` to match.
- **Room is full:** only two different live client IDs may join a room. Create
  a new room or close one participant's tab.
- **Second Mac cannot connect:** both users should open their own `localhost`
  app. Confirm both launchers are running, paste the full invitation code, and
  follow the hotspot/firewall checks in [docs/LAN_SETUP.md](docs/LAN_SETUP.md).
- **Direct LAN page has no encryption:** do not open
  `http://<creator-LAN-IP>:8080`. Web Crypto requires a secure context. Each
  participant must open their own `http://localhost:8080` page and let the
  joining backend relay over the LAN.
- **Encryption is waiting:** both participants must be connected and each must
  advertise a current browser key. Keep both tabs open and reconnect before
  retrying.
- **Key changed:** sending is intentionally paused. Compare the newly displayed
  safety code through a separate trusted channel before verifying and sending.
- **Repeated IV rejected:** retry encryption to rotate this browser's identity,
  then compare and accept or verify the new safety code before sending.
- **Session-only key:** IndexedDB was unavailable. Do not expect encrypted
  history to remain decryptable after refreshing or closing that browser
  session.
- **Messages remain after restart:** this is expected. They are stored in the
  named Docker volume. Phase 4 message bodies remain encrypted there.
- **Reset local data:** run `docker compose down -v`, understanding that this
  permanently removes the local chat database. This does not clear browser
  IndexedDB or local verification records; clear this site's browser data
  separately only if you intend to rotate that browser identity.

## Source report

The original report is referenced by the earlier handoff, but its
`docs/Project_Reference_Secure_Chat.docx` file is absent from this project copy.
The implemented boundaries are summarized in
[docs/PHASE_STATUS.md](docs/PHASE_STATUS.md)
