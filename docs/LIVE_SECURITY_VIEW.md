# Live security presentation

The **Encryption demo** button in the chat header opens **See what happens to
“hi”**. The compact live view is under **Live chat**; the earlier detailed view
described here remains under **Live activity & security details**.
For the new visible-key learning exercise, see [SIMPLE_ENCRYPTION_DEMO.md](SIMPLE_ENCRYPTION_DEMO.md).
Open the live view on the receiving Mac, then send from the other participant.
The path and recent observations update from operations in that browser.
For the sending side, send a message and open the view to review its evidence.
The dialog is read-only; it does not send demonstration messages automatically.

## Evidence and privacy

`useChat` records observations after its existing identity, public-key exchange,
derivation, encryption, WebSocket send, server acknowledgement and authenticated
decryption operations. It does not replace these operations or introduce a new
wire protocol. `securityTrace.ts` copies a small allowlist and retains at most 60
events in page memory. Room changes clear them. **Clear observations** clears
only this display, not messages, keys or safety-code verification.

Fields are event ID, kind, local timestamp, live/history classification,
direction, optional client message ID, ciphertext byte count and a shortened
prefix of actual ciphertext. Acknowledgements may additionally retain the
bounded public server record ID, server timestamp and duplicate flag received
in that actual response. No plaintext, private key, shared secret, AES key,
file descriptor, IV or raw error object is copied into the trace. It is never
sent to a server, logged or saved to local storage. The prefix is at most 32
base64url characters and omits at least four characters even for short messages.
These observations expose traffic metadata to whoever sees the screen.

Observation failures cannot interrupt encryption. Generation and socket checks
discard late observations belonging to a replaced session. History is marked
separately and excluded from the live display. An outgoing relay echo is local
evidence, not a remote delivery receipt. Unknown or evicted steps stay unknown.

The diagram follows the latest retained envelope in the chosen direction.
It does not replay an invented animated journey. A server acknowledgement means
acceptance for relay/storage. **Authenticated locally** requires successful
decryption by this browser. There is no recipient-decryption receipt protocol.
Times are local wall-clock readings, not synchronized latency measurements.

Media capabilities and protected attachment descriptors use chat envelopes and
therefore can appear in this trace. The separate encrypted HTTP file upload is
not measured here. Envelope bytes must not be described as file-transfer progress.

## BB84 comparison

**Run without Eve** and **Run with Eve** invoke the existing `bb84_start` command
with 1,024 trials, no noise, 25% sample, 11% threshold, seed 7 and respectively
0% or 100% interception. The two comparison cards retain only actual matching
reports while the lab stays open; a custom run is not mislabelled as a preset.
An error or unfinished run does not synthesize a result.

The transmission illustration reviews one of the returned redacted trace rows.
It shows actual Alice/Bob bases, the simulator's intercept flag, and a public
sample outcome when supplied. It does not display private bits or Eve's private
basis. The controls step through recorded rows; the backend still returns its
complete result in one event and does not stream per-transmission progress.

The teaching seed is public and deterministic. These runs demonstrate behavior,
not secret generation for production. BB84 remains independent of chat ECDH/HKDF
and AES-GCM. A low sample error does not establish the absence of an observer.
A passive packet capture is not BB84 intercept-and-resend and is not detected by
this lab. See [the panel runbook](PANEL_DEMO.md) for the actual demonstrations.

## UI ownership

`PresentationDialog` uses a native HTML dialog for background inertness, Escape
and focus restoration, with explicit Tab wrapping that skips closed disclosures.
It shares the application's typography,
colors, buttons and scroll treatment. It closes before switching to the existing
Security panel or BB84 modal. `LiveSecurityView` owns the observer diagram;
`EavesdroppingDemo` owns the comparison and recorded transmission visualization.
The existing `EncryptionStory` remains an explicitly conceptual explanation.

## Working copy

The upgraded source is in `bb84-secure-chat-starter 6`. The pre-upgrade source in
`bb84-secure-chat-starter final` is preserved. A source backup also exists at
`/private/tmp/bb84-before-live-presentation-20261113.tar.gz`. The isolated preview
uses Docker Compose project `bb84-presentation` and localhost port 8090; it does
not share the working LAN stack's database. For a two-Mac presentation, copy the
upgraded source to both Macs and run `./scripts/start_lan.sh` in each copy, using
localhost:8080 on both. A port-8090 preview cannot be mixed with the port-8080 LAN
stack; the current invitation format does not encode a port.

## Verification — 13 November 2026

| Check actually executed | Result |
| --- | --- |
| Frontend baseline before changes | 122 tests passed |
| Final frontend Vitest/RTL suite | 161 tests passed across 14 files |
| Backend Docker pytest suite | 133 tests passed |
| ESLint, zero warnings allowed | Passed |
| TypeScript and Vite production build, also in Docker | Passed |
| Strict design audit / DESIGN.md lint | Zero errors and warnings |
| Preview deployment | Healthy on localhost:8090, separate database |
| Browser chat | Two identities in two Chrome tabs; encrypted send and receive in both directions, history decryption after refresh, automatic reconnect after preview restart |
| Live view | Actual sender and receiver observations, updates while open, ciphertext prefix, clear without disrupting chat, history excluded |
| BB84 controls | Both real backend presets completed with 0% and 25% QBER; rejection skipped post-processing; chat stayed encrypted |
| Accessibility and layout | Desktop and 390 × 844 inspection; Tab wrapping, closed disclosures, Escape/focus restoration, transition to existing lab and security dialogs |

The 39 added frontend tests cover allowlisted and bounded observations,
instrumentation boundaries, outgoing acknowledgement semantics, incoming
authentication, evicted/history events, failed-send retries, actual comparison
results, redacted transmission examples and dialog keyboard behavior. Existing
crypto, fail-closed, verification, key-change and media tests remain in the suite.

The deployed API history was inspected for the harmless demo exchange: stored
rows were encrypted envelopes, lacked plaintext `text`, and did not contain the
demo sentence. Browser DevTools was clear during the initial message/lab/mobile
checks; restarting the isolated preview subsequently produced expected
WebSocket reconnect errors, followed by successful reconnection.

The historical report names screenshots and a strict audit under
`artifacts/presentation/`; those files are not included in this checkout and
cannot be reviewed here. The bundle sizes above are historical report values,
not a measurement of the current build.

This session did **not** perform a physical two-Mac acceptance run or a Wireshark
capture. The interactive browser check used two names/identities in one Chrome
incognito profile; it was not an independent-profile security audit. Manual
safety-code completion, key replacement and image/video transfer were not
repeated interactively in this presentation checkpoint; automated existing
tests passed. No BB84-assisted AES mode or remote decryption-receipt protocol
was implemented.

## Changed files

Existing code changed: `frontend/src/App.tsx`, `frontend/src/bb84.ts`, and
`frontend/src/hooks/useChat.ts`. The backend, WebSocket formats, dependency
manifests and `e2ee.ts` were preserved.

Added components and styles: `LiveSecurityView.tsx`, `live-security.css`,
`PresentationDialog.tsx`, `presentation-dialog.css`, `EavesdroppingDemo.tsx`,
`eavesdropping-demo.css` and `securityTrace.ts` under `frontend/src/`.
Added tests: `LiveSecurityView.test.tsx`, `PresentationDialog.test.tsx`,
`EavesdroppingDemo.test.tsx`, `securityTrace.test.ts` and
`hooks/useChat.trace.test.ts`.

Documentation changed: `README.md`, `DESIGN.md`, `docs/ARCHITECTURE.md`,
`docs/PHASE_STATUS.md`, `docs/TESTING.md`, `docs/TEST_RESULTS.md`; added this file
and `docs/PANEL_DEMO.md`. No paid services or new libraries were introduced.
