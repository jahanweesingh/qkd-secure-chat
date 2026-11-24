# One message, three clear steps

Open **Encryption demo** in the chat header. Enter **hi**, then select
**Encrypt & decrypt**. The screen shows the original message, the actual
ciphertext plus its authentication tag, and the recovered message. It also
shows the real AES key used by this isolated exercise. Run again to see new
keys and ciphertext even for the same message.

## Learn with keys

This mode performs real browser Web Crypto operations. Alice and Bob are both
represented inside the current browser; no second laptop or backend is involved.
The visible keys are newly generated for the exercise and never used by chat.

`learningCrypto.ts` creates two fresh, extractable P-256 key pairs. Each side
independently computes ECDH using its private key and the other's public key.
The function compares the resulting shared secrets, then applies HKDF-SHA-256
with a fresh 32-byte salt. Two different information strings bind the public
keys, direction and `QKD-CHAT-LEARNING-ONLY-v1` context. Both sides derive and
compare the two directional AES-256-GCM keys.

Alice's demonstration key encrypts the supplied text with a fresh 12-byte IV,
a 16-byte authentication tag and a fixed learning-only authenticated context.
Bob's independently derived matching key decrypts the result. The function
compares the recovered text before reporting completion. No simulated cipher
strings, delay-based progress or hardcoded secrets are used.

**See all example keys and values** reveals the real demonstration private
and public keys, shared secret, both directional AES keys, salt, derivation
contexts, IV, ciphertext and tag. Hex is the display encoding, not encryption.
Anyone who sees these demonstration keys can decrypt their demonstration
ciphertext. The purpose is inspection and learning, not private communication.

The engine has no dependency on production `e2ee.ts`, network APIs, storage or
logging. Results live in component memory. Editing the input, switching modes
or closing the dialog removes the previous result from the view; late results
are ignored. JavaScript does not promise secure erasure of previous heap bytes.
The unchanged chat engine keeps its non-extractable private keys and derived
AES keys outside this teaching component.

## Live chat

Select **Live chat** and **Send & watch** to send the entered text to the
actual room partner through the existing encrypted chat. This requires the
connection and chat keys to be ready. The display follows the latest ordinary
text message, using its full actual base64url ciphertext and the browser's
observations. Attachment manifests and media-control messages are excluded,
including malformed messages with those prefixes, because they may contain
secret file descriptors.

**Inspect the actual encrypted envelope** shows public envelope fields such
as algorithm, IV, key identifiers and ciphertext. Identifiers are not secret
keys. An actual `message_ack` supplies the server record ID, server timestamp
and duplicate flag. Only bounded, allowlisted values from that response enter
the local observation trace. The backend emits this acknowledgement after
its existing repository operation succeeds. Its current-key and IV-reuse
checks remain unchanged.

The sender's returned envelope can be authenticated and decrypted locally.
This is labeled **Local echo check** and is not presented as proof of the
partner's decryption. On the receiving browser, **Decrypted here** requires
the actual successful local authentication/decryption observation. Historical
messages may be inspected, but are not labeled as newly received traffic.
This is a frontend inspection of real operations and server responses, not a
stream of every internal server instruction or a network packet capture.

## A simple panel script

1. In **Learn with keys**, type **hi** and select **Encrypt & decrypt**.
2. Say: “Readable text becomes ciphertext. The matching key lets the receiver
   recover the text. These are real operations with disposable learning keys.”
3. Point at the AES key, then expand the example values only if asked about
   ECDH, HKDF, private keys, IVs or authentication tags.
4. Switch to **Live chat**, send **hi** to the other laptop, and inspect the
   actual envelope and backend acknowledgement. Explain why this mode keeps
   its real chat keys protected.
5. Open **BB84 lab**. Use **Start BB84 key exchange** to establish the
   endpoint-owned hybrid chat mode after both browsers confirm the key. Use
   **Start BB84 Experiment** for the separate Eve/no-Eve teaching comparison.
   Both BB84 activities are software simulations, not physical QKD; the hybrid
   mode provides no security independent of ECDH.

The chat has one demo entry, one encryption badge and a separate connection
badge. Repeated explanations have moved into disclosures. Necessary failures,
key changes and session-only storage warnings remain visible. Existing safety
verification, image/video transfers and LAN behavior are preserved.

For the complete two-Mac and packet-capture demonstration, see
[PANEL_DEMO.md](PANEL_DEMO.md). The upgraded folder remains
`bb84-secure-chat-starter 6`, with an isolated preview on localhost:8090.
The existing port-8080 stack is preserved. Use `./scripts/start_lan.sh` from the
updated copy on each Mac when you are ready to demonstrate the new interface
over LAN; both browsers then use their own localhost:8080.

## Verification checkpoint — 13 November 2026

- Baseline: 161 frontend tests passed before the changes.
- Final suite: **180 tests passed across 16 files**. The additional tests cover
  independent reconstruction of the displayed ECDH/HKDF/AES values, actual
  encryption/decryption, tampering and authenticated-context rejection, fresh
  keys/IVs, Unicode limits, stale asynchronous results, learning/live isolation,
  hidden media descriptors, retry evidence and real chat sending through the
  integrated dialog.
- ESLint passed with zero warnings. TypeScript and Vite production builds
  passed, including the Docker build. Final assets: 314.73 kB JavaScript and
  131.74 kB CSS before gzip.
- Strict design audit and DESIGN.md lint: zero errors and warnings.
- Chrome: ran the real **hi** learning exercise, inspected the visible key,
  created two test identities, sent **hi** through **Live chat**, inspected its
  actual full ciphertext/IV and backend acknowledgement, and observed successful
  decryption on the other window's live timeline. Escape restored focus to the
  Encryption demo trigger. The 390 × 844 layout was visually checked and the
  temporary viewport was reset. DevTools showed zero console messages in the
  tested live-chat window.
- The original report names screenshots
  `artifacts/presentation/08-simple-learning.png`,
  `09-simple-live.png`, `10-simple-mobile.png`, and `11-clean-chat.png`, plus
  `artifacts/presentation/simple-design-audit.json`. These assets are not
  included in this checkout and cannot be reviewed here. The report says the
  learning screenshot contains disposable learning keys; no screenshot is
  reproduced in this repository copy.

The backend, production `e2ee.ts`, dependency manifests and WebSocket contract
were unchanged. The previously passing 133-test backend suite was not rerun for
this frontend-only checkpoint. No physical two-Mac run, new image/video transfer,
packet capture or manual key-replacement test is claimed here; existing frontend
media, verification and fail-closed tests remain in the passing suite.

New source files are `frontend/src/learningCrypto.ts`,
`learningCrypto.test.ts`, `SimpleEncryptionDemo.tsx`,
`SimpleEncryptionDemo.test.tsx` and `simple-encryption-demo.css`.
Existing code changed in `App.tsx`, `App.test.tsx`, `styles.css`,
`PresentationDialog.tsx`, `PresentationDialog.test.tsx`, `securityTrace.ts`,
`securityTrace.test.ts`, `hooks/useChat.ts` and `hooks/useChat.trace.test.ts`.
README, design context and architecture/security/demo documentation were updated.
A source backup was created before editing at
`/private/tmp/bb84-before-simple-encryption-demo-20261113.tar.gz`.
