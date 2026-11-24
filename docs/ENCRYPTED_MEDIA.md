# Encrypted media design

## Key lifecycle and boundary

Before implementation, the chosen design preserves the existing ECDH/HKDF
directional AES-GCM message protocol and its 4,096-byte plaintext limit.
Files do not pass through an enlarged WebSocket envelope.

1. The sender chooses an image or video, reviews it, and presses Send file.
   A fresh encrypted challenge/acknowledgment verifies that the current partner
   supports media before any upload. It times out after eight seconds; controls
   are hidden from updated clients and never contain file secrets.
2. The browser generates a new random attachment UUID, 256-bit AES key and
   96-bit IV for that file. AES-GCM authenticates the bytes with context binding
   to the room and attachment identifier.
3. Only the encrypted bytes are uploaded to the room attachment endpoint.
   The server never receives the filename, original MIME type, file key or IV
   through that endpoint. It does learn the ciphertext size and identifier.
4. A bounded versioned manifest containing the identifier, filename, MIME type,
   size, key and IV is sent INSIDE the existing AES-GCM chat message. The outer
   envelope authenticates that metadata and preserves the existing sender,
   room, message-ID and directional-key binding.
5. The receiving browser decrypts the chat manifest, fetches ciphertext on an
   explicit Open action and authenticates/decrypts the file locally. It creates
   an in-memory Blob URL for the image or video. No decrypted media URL is sent
   back to the backend. Blob URLs are revoked when no longer needed.

Media manifests are never displayed as raw JSON, logged, or copied into UI
diagnostics. Unknown or malformed media records produce a safe error in the updated app.
Before uploading, a fresh encrypted capability challenge requires the partner
to acknowledge media support. Old clients cannot acknowledge and receive no file
key or descriptor; they may display the nonsecret capability probe. Both people
should refresh to the current app before demonstrating attachments. Ordinary messages still use the
original encryptText/decryptText code and fail-closed verification checks.

## Bounds and limitations

Images and videos are limited to 10 MiB each. Accepted types are JPEG, PNG, GIF,
WebP, MP4, WebM and Ogg video; SVG and HTML are excluded. A filename/type is not
a security proof: authentication, size bounds, signature checks and restrictive
rendering remain necessary. Browser codec support varies, so a decrypted file
can be downloaded if playback is unsupported. Video never autoplays.

The existing backend is a classroom relay without authenticated accounts.
Attachment ciphertext endpoints are therefore not a new access-control system.
Knowing a room/attachment ID may permit ciphertext retrieval. File secrecy
depends on the encrypted manifest and safe endpoints; safety codes must still
be compared out of band. Anyone with a compromised browser can read content.

Room storage is bounded at 32 files / 64 MiB, and the attachment database has a
512 MiB global ceiling. Files persist with SQLite; no automatic deletion is
introduced. A cancelled or disconnected upload may leave an orphan ciphertext
record, which counts toward quota. Oversized or full-room uploads fail clearly.
This first implementation buffers at most one bounded file per upload and does
not implement resumable streaming, large movies, file compression or transcoding.

The room-hosted BB84 teaching report remains separate from file and text keys.
The endpoint-owned exchange may activate the hybrid chat key that protects the
encrypted file descriptor; the file itself still uses its own random AES-GCM
key. Both BB84 activities are software simulations, not physical QKD, and make
no quantum-security claim.

## Interface ownership

The existing composer owns file selection, preview, cancellation and sending.
AttachmentMessage owns explicit download/decryption and safe media rendering.
EncryptionStory owns a collapsible explanation of actual encryption state and
the separate experiment. The existing security drawer retains verification.

## Browser API references

The per-file random key is used for one encryption operation, with a fresh IV
and room/file context in additionalData. See [Web Crypto AES-GCM parameters](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams).
Blob URLs are released after use; see [URL.revokeObjectURL](https://developer.mozilla.org/en-US/docs/Web/API/URL/revokeObjectURL_static).

## Delivery and verification — 12 November 2026

Live preview: **http://localhost:8088**. Refresh both browser profiles.
The original stack at port8080 is unchanged. The isolated upgrade preview now
runs the new backend and frontend with its existing volume preserved.

| Executed check | Actual result |
| --- | --- |
| Frontend unit/component/crypto suite | **122 passed across 9 files** |
| Backend suite | **133 passed**, including19 new attachment tests |
| ESLint and TypeScript | Passed |
| Production frontend/backend Docker builds | Passed |
| Two isolated production backend relay smoke | Passed, including bidirectional2MiB opaque file transfer |
| Two independent Chromium profiles | Passed, real PNG and WebM transfer/decryption/playback |
| Updated frontend static audit / DESIGN.md lint | Zero findings / zero errors or warnings |
| Running app/database health | Healthy |

The browser run verifies selection cancellation without upload; unsupported and
oversized files; an unacknowledged capability probe timing out with no upload;
new-client capability success; explicit open/decrypt/save; ciphertext length and
digest differing from the original file; filename/manifest absence from public
chat history; and media reopening after refresh. Both consoles had no errors or
warnings. Existing bidirectional text chat, manual safety-code verification,
key-change send blocking, BB84 outcomes, modal keyboard handling and responsive
checks remain in that run. Unit tests additionally cover tampered ciphertext,
wrong room/ID binding, bounded downloads, malformed/unsafe manifests, URL cleanup,
capability replay/key changes, and key changes while an upload is pending.

**Evidence availability:** This checkout does not include the browser report,
screenshots, static audit or test-only browser harness named by the original
handoff. Those artifacts cannot be reviewed or reproduced from this copy. No
replacement screenshots or results are asserted.

Physical two-Mac and Safari/iPhone codec checks were not performed. No independent
cryptographic audit is claimed. No new production dependency was added.

## Mentor demonstration

1. Open localhost:8088 in two independent browser profiles, join one room, and
   compare the full safety code through another trusted channel.
2. Send a text message. Use the paperclip, choose an image, review it and press
   **Send file**. On the other browser select **Open image**.
3. Send a short MP4 or WebM clip below10MB. Open it on the partner browser and
   use its playback controls. **Save video** downloads the locally decrypted file.
4. Expand **How protection works** to explain browser encryption, opaque server
   relay and recipient decryption. The explanation is conceptual, not a fake live
   packet animation. File content has its own fresh key protected by the chat.
5. Open **BB84 lab**. Use **Start BB84 key exchange** to show the confirmed
   hybrid chat mode, then use **Start BB84 Experiment** for the separate
   1024-bit Eve/no-Eve comparison. The room-hosted result does not supply chat
   keys; the file uses a separate random key protected in the chat envelope.

## Modified files

- `frontend/src/App.tsx`: preview/send/cancel controls, fail-closed upload gates,
  media message rendering, hidden capability controls, explanation integration.
- New `attachments.ts`, `AttachmentMessage.tsx`, `attachment.css`,
  `useMediaCapability.ts` and their three test files: bounded browser encryption,
  safe media rendering and authenticated feature negotiation.
- New `EncryptionStory.tsx`, `encryption-story.css`, `EncryptionStory.test.tsx`:
  collapsible conceptual explanation with actual state.
- New `chat-media.css`; updated `App.test.tsx`: minimalist composer/sidebar and
  integrated selection, validation and changed-key regressions.
- `frontend/nginx.conf`: bounded11MiB HTTP body allowance and blob media CSP.
- New `backend/app/attachments.py` and `backend/tests/test_attachments.py`;
  `backend/app/main.py`: opaque attachment storage/routes and POST CORS.
- `backend/tests/docker_relay_smoke.py`, `scripts/browser_ui_smoke.mjs`: actual
  LAN-route and browser media regression checks.
- `DESIGN.md`, README files, architecture/status/security/testing docs,
  this report, backup notes and `artifacts/media-upgrade` evidence.

The original report says the existing `e2ee.ts`, `useChat.ts` and Python BB84
implementation were compared with a pre-change backup. That backup and its
restore notes are not included in this checkout, so this comparison cannot be
repeated from the available files. The report describes attachment storage as
an additive SQLite table; existing encrypted chat rows and keys are not
migrated or replaced.
