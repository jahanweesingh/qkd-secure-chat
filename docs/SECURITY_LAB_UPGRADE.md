# BB84 Security Lab delivery report

Delivered: 12 November 2026.

The existing chat is preserved. The lab is easier to explain and now reports
real browser encryption state. **BB84 is still not connected to AES key
derivation.** A safe endpoint-owned integration needs a new protocol; the
design and implementation gates are documented in
[BB84_AES_INTEGRATION_PLAN.md](BB84_AES_INTEGRATION_PLAN.md).

## What changed

- **BB84 Security Lab:** Alice, Bob and Eve introductions, plain-language copy,
  and seven guided steps with actual backend values and encoding choices.
- **Honest results:** completed, high-error rejection, too few matching bits,
  correction failure, insufficient estimated material, and internal final-check
  failures each have an explanation and next action. Passing the error sample
  is not presented as successful final key preparation.
- **Walkthrough:** next/previous controls, direct step selection, review progress,
  and show-all mode. The backend returns all results together; the walkthrough
  reviews them afterward. There is no timer pretending to measure computation.
- **Privacy:** no actual or fabricated private-bit sample. Locks identify real
  trace positions; only public encoding choices and sample comparisons appear.
  No raw, reconciled, privacy-amplified or AES key bytes are rendered or exported.
- **Chat relationship:** a separate flow explains browser key establishment and
  AES encryption/decryption. Chat, connection, manual verification, and BB84
  status are independent. The contribution correctly says **Not connected**.
- **Progressive disclosure:** advanced settings and the full original technical
  diagnostics remain available. Hidden controls no longer enter the modal's
  keyboard focus cycle. Expanded technical reports fit narrow screens.
- **Two small pre-existing fixes:** WebSocket cleanup now survives task
  cancellation, removing departed participants/keys; the bit-count control
  captures its value before a deferred React update can clear the event target.

## What stayed the same

React/TypeScript/Vite, FastAPI, SQLite, Nginx and Docker Compose remain in place.
No package versions or dependency manifests were changed. No API event, message
schema, database migration, room code or LAN routing format was changed.

The browser cryptography and chat hook were compared byte-for-byte with the
backup and are unchanged: persistent non-extractable P-256 identities,
public-key exchange, HKDF directional keys, AES-256-GCM, random IV checks,
peer-key continuity, safety-code verification, encrypted history and fail-closed
sending all remain. The backend's immutable room lock and directional IV index
remain. The Python BB84/post-processing modules are unchanged.

## How to explain the key flow to a mentor

Each browser keeps its own private key. They exchange only public keys and use
ECDH to independently calculate the same shared secret. HKDF turns that into
two directional AES keys: Alice's sending key matches Bob's receiving key,
and Bob's sending key matches Alice's receiving key. The keys themselves do
not travel between the browsers. Each message is encrypted before it reaches
the relay and decrypted in the receiving browser.

Separately, Python plays both simulated roles in the BB84 experiment. It checks
errors, corrects differences and demonstrates shortening/confirming the shared
material. That temporary material is discarded and never supplies chat keys.
Encrypting it afterward would not undo Python's prior knowledge of it.

The proposed future mode would move the simulation to the endpoints, protect
its classical exchange with a verified ECDH-derived control channel, and mix
the locally agreed contribution with ECDH through a reviewed HKDF construction.
Both browsers would confirm a new key epoch before sending. This is a plan,
not an implemented, validated or quantum-secure mode.

## What the backend can see

For encrypted chat, the implemented relay receives public keys, ciphertext,
IVs, room and participant identifiers, names, timing, sizes and presence.
It does not receive the browser private keys, derived AES keys or message
plaintext through the encrypted-message contract. Legacy rows created before
an encryption lock can still be plaintext and remain explicitly marked.

For the BB84 lab, the backend temporarily knows **both** simulated private
sequences and demonstration material, because it calculates them. Its public
report contains only the allowed diagnostics. A public teaching seed permits
reconstruction; absence of key bytes from JSON is not a secrecy proof.

## Security limitations

This remains a classroom software demonstration. It performs no physical QKD
and makes no quantum-security claim. Users must compare all 12 safety-code
digits through a separate trusted channel; before verification an active relay
can substitute keys. Names are self-entered. Persistent P-256 keys provide no
forward secrecy or post-compromise security. Compromised browser code or a
device can read plaintext. Metadata is visible, LAN relay traffic lacks
production TLS, and the lab's entropy estimate is not a finite-key proof.

## Verification actually executed

The historical report states that a source/artifact backup was made because its
working copy had no Git metadata. The backup archive and its checksum/restore
notes are not included in this checkout, so they cannot be verified or restored
from these files.

The initial frontend baseline passed all **55** tests, lint, TypeScript and
production build. A fresh backend installation initially hung after 41 passing
cases at the existing departed-peer test: cancellation prevented its presence
notification. After the isolated cleanup fix, the full suite completed.

| Check | Actual final result |
| --- | --- |
| Local backend, Python 3.13, `python -m pytest -q -o faulthandler_timeout=15` | **114 passed** |
| Docker backend, Python 3.12, Compose `backend-test` | **114 passed** |
| Local frontend `npm test` | **75 passed** (55 existing + 19 walkthrough/status + 1 settings regression) |
| Docker frontend `frontend-test` | **75 passed**, lint, TypeScript and production build passed |
| Local ESLint / TypeScript / production build | Passed |
| Deployed Nginx/FastAPI Web Crypto smoke | Passed: real ECDH, matching codes, bidirectional AES, retries, IV/downgrade rejection, ciphertext history, BB84 report, capacity, typing and ping |
| Isolated two-production-backend relay smoke | Passed: public keys, opaque envelopes, ciphertext persistence, reconnect history, no plaintext downgrade and shared BB84 result |
| Two isolated Chromium profiles against Docker production build | Passed: two-way chat, safety-code comparison/local verification, refresh and history decryption, matching BB84 results, stage values, high-error and insufficient-material outcomes, chat after lab, ciphertext-only REST history, peer-key-change send pause |
| Browser layout and keyboard | Passed at 1440 × 1000 and 390 × 844, including open technical details, modal keyboard wrap, and mobile reduced-motion mode; no console errors/warnings |
| Design context lint / static UI audit | Passed, zero errors or warnings |

The browser run initially caught a technical-details overflow and the deferred
settings-event bug. Both were fixed and the full browser flow rerun successfully.
The final bundle is 258.86 kB JavaScript (79.93 kB gzip) and 94.27 kB CSS
(20.01 kB gzip). No production dependencies were added.

**Evidence availability:** The historical report describes a browser report and
ten screenshots under `artifacts/upgrade-ui/`. That directory is not included
in this checkout, so those screenshots and measurements are unavailable for
review here. No substitute evidence is presented.

Two **physical Macs** were not available. The Docker relay test checks the
network route; it is not a claim of physical hotspot/firewall acceptance.
No independent cryptographic audit, full screen-reader audit, or hybrid-mode
test is claimed. No live per-stage backend stream was implemented.

## Historical demonstration procedure

The original procedure described a preview at **http://localhost:8088** under
Compose project `bb84-upgrade-check`. Its isolated configuration,
`artifacts/upgrade-ui/preview.env`, is not included in this checkout, so that
preview cannot be started from the repository as provided. The normal local
Docker and LAN procedures remain in [the testing guide](TESTING.md) and
[LAN setup](LAN_SETUP.md).

The historical mentor scenario used two browser profiles, safety-code
comparison, and BB84 settings with and without simulated Eve. The report says
chat encryption remained independent of that teaching experiment. The scenario
is a description of the prior report, not a new run or a current test result.

## Browser-check reproduction availability

The original browser check depended on
`artifacts/upgrade-ui/harness` and its generated preview configuration. Neither
is included in this checkout, so the old disposable-container commands cannot be
run from these files. Use the maintained [testing guide](TESTING.md) for current
test procedures. No new browser run or screenshot is claimed here.

## File-by-file manifest

| File | Change |
| --- | --- |
| `frontend/src/App.tsx` | Reused lab shell/settings/diagnostics; wired actual encryption status, disclosures and walkthrough; fixed focus and deferred select event |
| `frontend/src/SecurityLabWalkthrough.tsx` | New participant introduction, status relationship and seven-step result review |
| `frontend/src/security-lab.css` | Scoped responsive lab styling |
| `frontend/src/SecurityLabWalkthrough.test.tsx` | 19 new result/state/keyboard tests |
| `frontend/src/App.test.tsx` | Preserved existing checks with new labels/disclosures; one settings regression test |
| `backend/app/main.py` | Shielded and bounded disconnect cleanup |
| `scripts/browser_ui_smoke.mjs` | Extended actual-browser regression coverage and JSON report; removed safety-code console output |
| `README.md`, `frontend/README.md` | Current behavior, entry points and test count |
| `docs/ARCHITECTURE.md`, `docs/PHASE_STATUS.md` | Presentation architecture and deferred integration status |
| `docs/PHASE4_SECURITY_UX.md`, `docs/PHASE4_E2EE_THREAT_MODEL.md` | Honest lab statuses and unchanged cryptographic boundary |
| `docs/TESTING.md`, `docs/TEST_RESULTS.md` | New acceptance procedure and clearly historical old checkpoint |
| `docs/BB84_AES_INTEGRATION_PLAN.md` | Current key lifecycle, rejected shortcut, endpoint-owned proposal and implementation gates |
| `docs/SECURITY_LAB_UPGRADE.md` | This delivery report and mentor guide |
| `DESIGN.md` | Existing visual tokens, component ownership and progressive-disclosure rules |
| `backups/` | The historical report names a backup archive; it is not included in this checkout. |
| `artifacts/upgrade-ui/` | The historical report names screenshots, a report and a browser harness; they are not included in this checkout. |

All original project files remain. The existing encryption code, hook,
simulation, post-processing, relay, database and dependency manifests were
preserved; no replacement framework or external service was introduced.
