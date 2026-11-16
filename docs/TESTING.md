# Testing Guide

## Simple message demonstration

Open **Encryption demo**. The initial **Learn with keys** mode runs entirely
locally and can be used without a partner. Test **hi**, a Unicode message and
an over-limit input. A completed run shows actual ciphertext, decrypted text and
its disposable AES key. Editing or changing modes must remove the previous
learning result. Repeating the same input must create fresh keys and ciphertext.

With both chat participants connected, switch to **Live chat**, send **hi**,
and inspect the actual envelope and server acknowledgement. An acknowledgement
must not claim the partner decrypted it. The sender's own decrypted echo must
be labeled local. Attachment/control plaintext must never appear in this view.
The detailed prior view is now inside **Advanced: live observations and security
details**. See [SIMPLE_ENCRYPTION_DEMO.md](SIMPLE_ENCRYPTION_DEMO.md) for the
executed checks and limits.

## Live presentation acceptance

1. Join one room with two distinct browser identities. Open **Live security
   view** on the receiver and send a message from the other browser. Confirm
   the incoming view updates only after real receipt and authenticated
   decryption. The sender's acknowledgement must not imply remote decryption.
2. Refresh and rejoin with the same identity. Confirm history decrypts in chat
   but does not appear as new traffic in the live view. Clear observations;
   messages and encryption must remain intact.
3. Test a failed send followed by retry: the latest outcome must replace the
   failed stage while earlier observations stay in the timeline.
4. Open **BB84 lab** and use **Run without Eve**, then **Run with Eve**. Compare
   the displayed numbers with the actual reports. Expected seed-7 results are
   0/132 and 33/132 sample mismatches. Neither run changes the chat keys.
5. At desktop and 390 × 844, inspect layout and keyboard navigation. Tab must
   wrap within the presentation dialog; Escape must restore focus. Switching
   to the lab or security details must close the presentation first.

See [PANEL_DEMO.md](PANEL_DEMO.md) for the two-Mac presentation and scoped
Wireshark instructions. A packet capture is a separate manual acceptance step;
automated UI observations do not constitute one.

## BB84 Security Lab acceptance

The existing commands below still apply; no dependency or wire-format change
is required. The current frontend suite includes a separate
`SecurityLabWalkthrough.test.tsx` for recorded stage values, hidden private bits,
status independence, all post-processing failures, and keyboard step navigation.
The existing App tests now open the advanced/technical disclosures explicitly.

In two independent browser profiles:

1. Join one room with different names. Exchange messages and compare the full
   safety codes through a separate trusted channel. Mark the current pair
   verified locally. Refresh one browser and confirm matching history decrypts.
2. Open **BB84 lab**. Check that **How does this protect our chat?** reflects
   the actual browser key state and says **BB84 key contribution: Not connected**.
3. Choose 1024 bits, no Eve, no background noise. Under advanced settings use
   seed 7 for a repeatable demonstration; select **Start BB84 Experiment**.
4. Review all seven steps or use **Show all steps**. Compare counts to the
   technical report. Progress represents review, not live server computation.
5. Run again with Eve at 100%. Confirm sample rejection and skipped final
   preparation. Set Eve back to 0% and choose 128 bits; confirm the clean sample
   can pass while final preparation stops for insufficient estimated material.
6. Exchange another encrypted message. No lab outcome should change the chat
   key, safety-code decision, or encryption-required room lock.
7. At 390 × 844, open technical details and verify the lab fits the screen while
   its trace table scrolls internally. Tab/Shift-Tab must skip closed
   disclosures; Escape closes the lab and restores focus to its trigger.
8. Test key replacement in a disposable browser profile only. The peer must
   detect the change and pause sending. Never clear a real user's keys as a test.

`scripts/browser_ui_smoke.mjs` automates this flow against a running app and two
separate Chrome debugging endpoints. It now also checks backend result values,
rejected/small runs, ciphertext-only REST history, refresh and key-change pause.
Use disposable Chrome profiles; the script deliberately clears Bob's test
identity at the end. Set `CHAT_BASE_URL`, `CHROME_DEBUG_URL`,
`CHROME_DEBUG_URL_SECONDARY`, and `UI_SMOKE_ARTIFACT_DIR` as described below.
For physical Macs, the existing [LAN_SETUP.md](LAN_SETUP.md) process is unchanged:
both people open their own localhost app and use the complete LAN invitation.

See [SECURITY_LAB_UPGRADE.md](SECURITY_LAB_UPGRADE.md) for actual executed
checks and remaining hardware acceptance work. No BB84/AES hybrid tests are
claimed because that mode is not implemented.

## Full Docker verification

```bash
docker compose --profile test build
docker compose --profile test run --rm backend-test
docker compose --profile test run --rm frontend-test
docker compose up --build -d
docker compose --profile test run --rm smoke
```

The Docker smoke test reaches the application through Nginx, creates two real
P-256 identities with Node Web Crypto, derives and compares the safety code,
encrypts and decrypts messages in both directions, checks ciphertext-only
SQLite history, rejects plaintext downgrade and IV reuse, checks typing and
ping/pong, and rejects a third participant.

For the strongest visual browser pass on macOS, launch two isolated headless
Chrome profiles in separate terminals and leave both processes running:

```bash
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new \
  --remote-debugging-port=9225 \
  --user-data-dir=/tmp/qkd-chat-ui-smoke \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

```bash
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new \
  --remote-debugging-port=9226 \
  --user-data-dir=/tmp/qkd-chat-ui-smoke-peer \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

In a third terminal, from the project root, run:

```bash
CHROME_DEBUG_URL=http://127.0.0.1:9225 \
CHROME_DEBUG_URL_SECONDARY=http://127.0.0.1:9226 \
node scripts/browser_ui_smoke.mjs
```

The browser smoke uses two isolated browser profiles, records screenshots in
`artifacts/ui-smoke/`, verifies safety-code matching and two-way decryption,
and checks desktop and 390 by 844 layouts for overflow and console errors.
Set either debugging URL if Chrome listens on different endpoints, or
`CHAT_BASE_URL` if the application is not on
`http://127.0.0.1:8080`.

The current verification record is in
[`docs/TEST_RESULTS.md`](TEST_RESULTS.md). It records the confirmed source,
Docker and browser evidence for this release candidate.

## Backend tests

```bash
cd backend
python -m pytest
```

The backend suite should cover:

- strict `e2ee_hello` and `encrypted_message` schemas, canonical base64url,
  P-256 public-key IDs, 96-bit IVs and ciphertext/tag size bounds;
- raw-byte public-key ordering and exact cross-implementation `key_id`
  vectors;
- first-hello durable `e2ee_required` locking, repository-level plaintext
  rejection and explicit legacy-row labeling;
- two current, distinct public-key advertisements before accepting an
  encrypted envelope;
- current-pair enforcement, immutable message-ID retries and directional
  `(room_id, key_id, sender_key_id, iv)` reuse rejection;
- ciphertext-only persistence and relay events with no encrypted-message
  `text` field;
- peer departure/key replacement invalidating the prior pair before another
  send;
- known basis-sifting and QBER calculations;
- repeatable seeded simulations and explicit treatment of their public,
  reconstructible output as non-secret;
- ideal zero-noise behaviour;
- the expected statistical trend toward 25 percent QBER under full
  intercept-resend, without requiring one finite run to equal 25 percent;
- noise, insufficient retained data and threshold-abort paths;
- every `bb84_start` bound and rejection of extra fields;
- a maximum 24-row trace with comparisons only for disclosed samples;
- one-use private candidate transcripts and best-effort cleanup on every
  processing exit path;
- bounded Cascade-inspired reconciliation, exact parity-leakage accounting,
  successful correction and a safe `reconciliation_failed` path;
- binary-entropy and illustrative usable-bit calculations, including the
  32-bit margin and separate `insufficient_entropy` result;
- known Toeplitz-hash behavior and strict input dimensions;
- independent truncated HMAC-SHA-256 confirmation, context changes and tamper
  rejection, including the defensive `confirmation_failed` report path;
- context-bound HKDF-SHA-256 agreement, output separation and the defensive
  `derivation_failed` report path;
- completed, skipped and failed post-processing reports;
- recursive absence of candidate bits, reconciled bits, Toeplitz seeds,
  privacy-amplified values, confirmation tags, HKDF salts and derived bytes
  from the public payload;
- one identical `bb84_result` broadcast to both local participants;
- recoverable serialization of simultaneous requests in one room;
- no persistence or reconnect replay of any Phase 3 result or private material;
- guest initiation through the relay with the creator remaining authoritative;
- all existing health, history, capacity, persistence, origin and relay tests.

## Frontend tests

```bash
cd frontend
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

The current automated interface suite covers exact P-256 pair-ID and
directional HKDF vectors, AES-GCM round trips, ciphertext and authenticated-
metadata tamper rejection, strict encrypted-envelope validation, the symmetric
12-digit safety code, encrypted WebSocket send/receive behavior, explicit
verification, changed-key blocking, repeated-IV failure, malformed encrypted
input, live plaintext-downgrade rejection, oversized UTF-8 draft retention and
the independent Protocol Lab. It also covers a peer-key replacement after room
reopen, identity rotation after IV reuse, unavailable-key history rendering,
onboarding validation, local and routed invitations, connection and capacity
behavior, result parsing, timeout/busy states, result presentation and
Protocol Lab keyboard-focus handling.

Do not infer untested coverage from the frontend test count. IndexedDB key
persistence, the direct non-localhost HTTP guard, disconnect recovery, reduced
motion, zoom and layout at real viewport sizes remain manual or
browser-acceptance checks below. The backend suite separately verifies the
durable E2EE room lock, plaintext-downgrade rejection and directional IV
uniqueness.

## Manual local check

1. Open `http://localhost:8080` in two browser profiles or windows with
   independent storage.
2. Join the same room using different names.
3. Wait until both clients show **Encrypted · Unverified**. Confirm the
   connection status remains a separate indicator.
4. Compare all 12 safety-code digits through a channel outside this chat and
   mark the pair verified in both browsers. Confirm the UI says verification
   is local to this browser, not an authenticated account.
5. Send messages in both directions. Confirm only authenticated, locally
   decrypted text becomes a normal message bubble. Inspect the REST history
   and SQLite row: an encrypted record contains `iv`, `ciphertext` and key
   metadata with no `text` value.
6. Refresh a browser with IndexedDB persistence. Confirm it reuses its room/
   profile identity and can decrypt matching history. Force IndexedDB failure
   separately and confirm **Key lasts for this tab** appears.
7. Change or clear one browser identity. Confirm the other client pauses
   sending, no longer applies prior verification and requires the new code to
   be reviewed.
8. Open the Protocol Lab and run 1,024 qubits with zero noise, zero
   interception, a 10 percent disclosed sample and teaching seed `1`.
9. Confirm both windows show the same session ID, starter, configuration,
   BB84 metrics, post-processing report and trace. Confirm the four Phase 3
   stages read Reconcile, Reduce exposure, Confirm and Derive.
10. Confirm the result explains reconciliation leakage, the illustrative
   entropy estimate, 128-bit privacy-amplification output and discarded
   256-bit HKDF demonstration output. It must say the lab material never
   supplies or changes the separate chat keys.
11. Run a small ideal 128-qubit experiment. Confirm BB84 may be accepted while
   post-processing separately reports `insufficient_entropy` and explains that
   a KDF cannot create missing entropy.
12. Set full intercept-resend and run several sufficiently large experiments.
   Confirm observed QBER varies around the theoretical 25 percent trend rather
   than always equalling it. An aborted BB84 result must show Phase 3 as
   skipped.
13. Set enough noise to exceed the threshold and confirm both windows show an
   aborted decision and `bb84_not_accepted` processing reason.
14. Confirm the interface never displays candidate or reconciled bits, secret
   material, confirmation tags or a generated Protocol Lab key. Its
   `chat_encryption_active: false` field must be explained as referring to that
   simulation output, not as disabling Phase 4 browser E2EE.
15. Send encrypted messages after completed, failed and skipped experiments.
   Confirm the Protocol Lab result does not gate or rekey chat.
16. Refresh one participant. Confirm ciphertext history returns but the
   previous protocol result is not replayed.
17. Repeat at a narrow mobile viewport and with keyboard-only controls.

## Real dual-host relay smoke test

Preserve the existing two-Mac setup. Start one independently configured
instance on each trusted-LAN Mac with `./scripts/start_lan.sh`, then provide the
local endpoints and creator address to the automated relay check:

```bash
CREATOR_BASE_URL=http://127.0.0.1:8080 \
JOINER_BASE_URL=http://127.0.0.1:8081 \
CREATOR_LAN_IP=192.168.1.42 \
node scripts/dual_host_chat_smoke.mjs
```

This legacy dual-host relay-regression script predates the dedicated browser
acceptance helper. Use the Phase 4 hardware procedure below for the security
demonstration; do not treat the legacy script by itself as browser E2EE proof.

For the Phase 4 hardware check, keep both browsers on their own
`http://localhost:8080` pages, join one invitation across the two backends,
wait for both browsers to derive the same safety code, compare all 12 digits,
exchange encrypted messages, refresh each side and inspect the creator history
for ciphertext-only rows. The direct creator LAN URL is not a supported
browser client. Keep both Macs on the same trusted, non-guest network and
follow
[`LAN_SETUP.md`](LAN_SETUP.md) for firewall and CLAT/NAT64 troubleshooting.

The backend test image also includes `tests/docker_relay_smoke.py`, used by the
isolated two-production-backend Docker check. It validates public-key
advertisement, an opaque encrypted envelope, ciphertext-only persistence,
plaintext-downgrade rejection and the independent Phase 3 result across the
relay. Because its synthetic envelope is not created or decrypted by a real
browser, it complements rather than replaces the two-browser check.

## Security-negative checks

- Confirm a non-secure, non-loopback browser origin pauses setup and instructs
  each Mac to use localhost or HTTPS.
- Confirm the backend and SQLite never receive encrypted-message plaintext,
  browser private keys, shared ECDH material, derived AES keys or safety codes.
- Confirm malformed public keys, non-canonical base64url, wrong pair-key IDs,
  wrong algorithms, oversized ciphertext and extra JSON fields are rejected.
- Force IV duplication under the same directional key. Confirm the client
  rejects it before encryption and the backend separately returns
  `e2ee_iv_reuse` for a repeated `(room, key_id, sender_key_id, iv)` tuple.
- Alter the ciphertext, IV and each authenticated metadata field. Confirm
  AES-GCM returns no plaintext and sending pauses.
- Confirm first hello makes the room permanently `e2ee_required`, including
  after restart, and both the WebSocket and repository reject plaintext.
- Confirm **Encrypted · Unverified** never implies authenticated identity and
  that only a local user action can store verification for the current pair.
- Confirm peer-key replacement clears verification and blocks sends. Reusing
  the same persistent key is not described as rekeying or forward secrecy.
  Leave and reopen the room to confirm the remembered local peer-key ID still
  detects a replacement.
- After `e2ee_iv_reuse`, confirm retry rotates the local identity, clears the
  previous verification and requires the replacement safety code to be
  reviewed before sending.
- Search the database and logs to confirm no candidate or reconciled bits,
  Toeplitz seed, confirmation tag, HKDF salt or derived material is persisted.
- Verify a malformed or oversized simulation event returns a bounded error and
  leaves both chat connections usable.
- Verify an accepted result still reports `simulation_only: true` and
  `chat_encryption_active: false`.
- Verify every report keeps `key_material_exposed: false`,
  `key_used_for_chat: false` and `derivation.material_retained: false`.
- Confirm a seeded run is labelled `reproducible_teaching_run: true` and is
  never described as cryptographically random. Confirm the UI and docs warn
  that its public seed and settings make it reconstructible and non-secret.
- Confirm `key_material_exposed: false` is explained as absence of serialized
  key bytes, not as a secrecy guarantee.
- Confirm Phase 4 chat remains encrypted independently of the Protocol Lab and
  is never presented as protected by the simulation.

## Encrypted media acceptance

Use the paperclip to send a PNG and a short MP4/WebM under10MB between updated
browser profiles. Open them on the recipient, play the video, refresh and rejoin,
and reopen both from history. Cancel a selection and reject an oversized file.
Expand How protection works and verify BB84 remains separate. The browser smoke
now performs these checks plus a missing-capability acknowledgment test. See
[ENCRYPTED_MEDIA.md](ENCRYPTED_MEDIA.md) for lifecycle, quotas and actual results.
