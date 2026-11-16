# Phase 4 Classroom E2EE Threat Model

> **Visible-key learning mode:** the separate `learningCrypto.ts` exercise
> intentionally exports fresh demonstration keys so students can inspect them.
> It runs both modeled participants in one browser and has no network, storage
> or production-key dependency. Displayed keys offer no confidentiality from
> the audience. The protected chat-key boundary described below is unchanged.
> See [SIMPLE_ENCRYPTION_DEMO.md](SIMPLE_ENCRYPTION_DEMO.md).

> **Encrypted media update (12 November 2026):** images and videos now use a
> fresh browser AES-GCM file key, opaque HTTP storage and a key-bearing descriptor
> protected by the existing chat envelope. See [ENCRYPTED_MEDIA.md](ENCRYPTED_MEDIA.md)
> for the capability gate, key lifecycle, quotas and limitations. Text key
> establishment and the independent BB84 simulation remain unchanged.

The November 2026 dashboard upgrade does not change this cryptographic model.
BB84-assisted derivation remains unimplemented. The feasibility assessment,
current lifecycle and future endpoint-owned design are in
[BB84_AES_INTEGRATION_PLAN.md](BB84_AES_INTEGRATION_PLAN.md). In particular,
server-known simulated material is not transferred to browsers or mixed into
chat keys. A successful displayed experiment supplies no additional protection
to this ECDH-only chat.

## Implemented boundary

Phase 4 adds a browser-to-browser encryption slice to the two-person classroom
chat. It uses:

- P-256 Elliptic Curve Diffie-Hellman in each browser;
- HKDF-SHA-256 to derive separate low-key-to-high-key and
  high-key-to-low-key message keys;
- AES-256-GCM with a fresh random 96-bit IV and 128-bit tag for each message;
- a 12-digit safety code derived locally from both browser public keys and the
  ECDH shared secret;
- a non-extractable ECDH private `CryptoKey` and its exportable public
  counterpart persisted as a key pair in IndexedDB for the room/profile when
  supported;
- a page-session key fallback when IndexedDB key persistence is unavailable;
- ciphertext-only message persistence on the room backend; and
- an immutable `e2ee_required` room lock that rejects plaintext chat.

The Phase 3 BB84 and post-processing pipeline remains a separate teaching
simulation. Its candidate bits, Toeplitz output and HKDF demonstration output
do not seed, unlock, verify or rekey Phase 4 chat.

## Deployment shape

Each participant runs the application on their own Mac and opens it through
that Mac's `http://localhost:8080` address. Browsers treat localhost as a
potentially trustworthy context, so Web Cryptography is available. The two
local backends relay public-key advertisements and encrypted envelopes across
the LAN.

Opening the creator Mac directly at `http://<creator-LAN-IP>:8080` is not a
supported Phase 4 client path. It is not a secure browser context and lets a
network intermediary replace the application code. Both people must use their
own localhost application.

The backend-to-backend LAN hop is not TLS-protected in this classroom slice.
Chat content is encrypted before that hop, but room codes, self-entered names,
public keys, timing, message sizes and presence remain visible. HTTPS/WSS and
authenticated client distribution remain required before public deployment.

## Two independent status axes

- **Connection** reports whether the WebSocket and LAN relay are available.
- **Encryption** reports whether the local browser holds matching message keys
  and whether this user compared the safety code.

`Connection: Live` does not mean encrypted. Backend receipt of public keys does
not mean that the local browser derived usable keys. A passed Protocol Lab
experiment does not change either state.

## Assets

Phase 4 is intended to protect:

- message plaintext before it leaves the sending browser;
- browser ECDH private keys and derived AES keys;
- message integrity and authenticated envelope metadata;
- the local record of a safety-code comparison; and
- unsent drafts.

The first slice does not hide:

- room ID and invitation data;
- self-entered participant names and client identifiers;
- public ECDH keys and their identifiers;
- presence, timing, ciphertext length or traffic volume; or
- the fact that a BB84 teaching experiment was run.

The AES-GCM additional data authenticates the protocol version, room,
sender/client identifiers, sender display name, client-message ID and key IDs.
The server-assigned database ID and `sent_at` timestamp are not authenticated
by the sender, so the relay remains able to alter timing and ordering metadata.

## Trust assumptions

### Trusted

- both participants' Macs, browser profiles and operating systems;
- the exact frontend build loaded from each Mac's localhost origin;
- the browser's Web Cryptography implementation;
- IndexedDB for origin-scoped key-object persistence, when available; and
- the separate channel used to compare the safety code.

### Not trusted with chat plaintext

- either room backend;
- SQLite;
- the backend-to-backend LAN relay;
- the hotspot, Wi-Fi network and passive network observers; and
- invitation delivery.

### Endpoint limitation

The web application is an endpoint. Malicious local code, cross-site scripting,
a compromised dependency, browser extension, browser profile or operating
system can read plaintext or ask a non-extractable key to perform cryptographic
operations. `extractable: false` prevents normal key export through Web Crypto;
it does not make a compromised browser or device safe.

Web Crypto does not promise hardware-backed storage or physical memory
zeroization. Clearing browser storage may destroy the persistent key and cause
a new public key and safety code.

## Adversaries

### Passive LAN observer or honest-but-curious relay

May record setup events, public keys, metadata and encrypted envelopes. After
local key setup, the observer should not learn message plaintext from those
envelopes. Metadata remains visible.

### Active relay or network attacker

May replace exchanged public keys, show different setup data to each browser,
drop, delay, replay or reorder envelopes, or deny service. This slice has no
signed identity key or authenticated account handshake. Encryption with an
unverified peer key therefore remains susceptible to an active
man-in-the-middle.

Comparing the complete safety code through a separate trusted channel detects
public-key substitution because the two browsers will calculate different
codes. If users do not compare it, the UI must say
**Encrypted · Unverified** and must not imply authenticated identity.

The relay can still deny service and alter unauthenticated metadata after a
successful comparison. E2EE does not make the server unable to interfere.

### Person who knows the room code

May occupy the second participant slot or present a different public key. The
room code is an invitation capability, not proof of a person's identity.
Manual code comparison confirms a key pair, not a name or account.

### Compromised participant endpoint

Can read that participant's drafts, plaintext, history and active keys. Phase 4
does not protect against screenshots, copying, a malicious conversation
partner or endpoint compromise.

## Room security lock

The first accepted `e2ee_hello` durably marks the room `e2ee_required`. That
lock is immutable. The repository also enforces it so a legacy plaintext
`message` cannot be inserted after encryption is required.

Failure never removes the lock. To use plaintext, participants must leave and
deliberately create a different room. One room must never mix new plaintext and
encrypted history. Any old plaintext row that predates the lock is explicitly
marked `legacy_plaintext`; it is not relabeled as encrypted.

## Browser identity key

The identity scope is the colon-joined Phase 4 version, room code and local
display name after `trim().toLocaleLowerCase()`. That scope loads or creates a
P-256 ECDH key pair. It is a browser-storage lookup key, not an authenticated
account identity.

- The private key is a non-extractable `CryptoKey` with `deriveBits` use.
- The public key is exported as the raw 65-byte SEC1 uncompressed point.
- The public wire form is canonical unpadded base64url, 87 characters.
- `public_key_id` is unpadded base64url SHA-256 of those 65 raw bytes,
  43 characters.
- The backend validates the format, prefix and identifier. The importing
  browser validates that the point belongs to P-256.

The key pair is stored in IndexedDB database `qkd-chat-e2ee`, store
`room-identities`, when browser structured cloning of `CryptoKey` works. If
IndexedDB read or write fails, the application keeps a key only in its
in-memory session map. That fallback must be visible because refresh or tab
close changes the key and invalidates prior verification.

The browser separately remembers the first valid peer `public_key_id` in
`localStorage`, scoped to the same version, room and local profile. A later
different peer ID enters `key_changed` even after leaving and reopening the
room. Explicitly accepting the replacement updates the local record and leaves
the pair unverified. This is a trust-on-first-use continuity signal. It cannot
authenticate the first observed key, and clearing site storage removes it. If
`localStorage` is blocked, the pin remains only in page memory and cannot
provide continuity after the page closes.

Neither the private ECDH key nor derived AES keys are sent to the backend,
written to SQLite, logged or placed in Protocol Lab reports.

## Public-key wire contract

Browser to server:

```json
{
  "type": "e2ee_hello",
  "version": "e2ee-v1",
  "algorithm": "ECDH-P256",
  "public_key_id": "<43-char canonical base64url SHA-256>",
  "public_key": "<87-char canonical base64url raw P-256 point>"
}
```

The server broadcasts `e2ee_public_key`, adding `client_id` and
`display_name`. The initial `connected` event includes:

- `e2ee_required: boolean`; and
- `e2ee_public_keys`, containing any active peer advertisements.

The backend rejects two active participants advertising the same public-key ID
with `e2ee_public_key_conflict`. Public advertisements are routing and setup
data, not authenticated participant identities.

## Pair key identifier and directional keys

Both clients and the backend calculate:

```text
pair_transcript =
  UTF8("QKD-CHAT-E2EE-PAIR-KEY-ID-v1\0") ||
  U16BE(length(UTF8(room_id))) || UTF8(room_id) ||
  min_raw_key || max_raw_key

key_id = BASE64URL_NO_PAD(SHA-256(pair_transcript))
```

`min_raw_key` and `max_raw_key` use byte-for-byte lexicographic order of the
two 65-byte public keys. Sorting their base64url text instead is not equivalent
and is prohibited.

Each browser derives a 256-bit P-256 ECDH shared secret and imports it as HKDF
input. HKDF-SHA-256 uses:

- salt: the 32-byte `key_id` transcript hash; and
- info: `e2ee-v1/AES-256-GCM/low-to-high` or
  `e2ee-v1/AES-256-GCM/high-to-low`.

The browser with the lexicographically lower raw public key sends with the
low-to-high key and receives with the high-to-low key. The other browser does
the reverse. Both AES-256-GCM keys are non-extractable.

Directional separation prevents both senders from sharing one AEAD key and IV
namespace. HKDF output size does not increase the strength of P-256 or repair
an unauthenticated public-key exchange. Product copy must not advertise
**256-bit security**.

## Locally derived safety code

The backend never creates, compares or verifies the code. Each browser derives:

```text
verification_digest = SHA-256(
  UTF8("e2ee-v1/verify\0") ||
  pair_transcript_hash ||
  ecdh_shared_secret
)

verification_number = UINT48_BE(verification_digest[0:6]) mod 10^12
```

The result is left-padded to 12 digits and displayed in three groups of four,
for example `1234 5678 9012`.

A verification decision is local browser state keyed by room and current
`key_id`. It records only that the user said the complete codes matched. A
backend event must never create it.

A 12-digit display has about 40 bits of possible values. It is a classroom
manual-comparison mechanism, not a replacement for authenticated accounts or a
claim of 128-bit identity authentication.

## Encrypted-message wire contract

Browser to server:

```json
{
  "type": "encrypted_message",
  "client_message_id": "<1-64 allowed characters>",
  "version": "e2ee-v1",
  "algorithm": "AES-256-GCM",
  "key_id": "<current pair key ID>",
  "iv": "<16-char canonical base64url of 12 random bytes>",
  "ciphertext": "<canonical base64url ciphertext plus 16-byte tag>"
}
```

The client does not send `sender_key_id`; the server attaches the ID from the
sender's active `e2ee_hello`. The server broadcasts and stores:

```text
id, client_message_id, sender_id, sender_name, sent_at,
kind="encrypted_message", version, algorithm, key_id,
sender_key_id, iv, ciphertext
```

No plaintext field exists for an encrypted row. Plaintext is limited to 4,096
UTF-8 bytes. The stored ciphertext includes a 16-byte GCM tag, so its decoded
range is 17 through 4,112 bytes.

## AES-GCM processing

For every outgoing message, the browser:

1. encodes 1 to 4,096 UTF-8 plaintext bytes;
2. generates a random 12-byte IV with `crypto.getRandomValues`, checks it
   against the set already used by the current send key and records it before
   encryption;
3. builds authenticated additional data from newline-separated
   `version`, `room_id`, `sender_id`, `sender_name`, `client_message_id`,
   `sender_key_id` and `key_id`;
4. encrypts with the directional AES-256-GCM key and a 128-bit tag; and
5. sends only the envelope.

Every associated-data field must pass its existing validation before entering
this encoding. Future field changes require a new protocol version; otherwise
ambiguous concatenation may become possible.

AES-GCM requires IV uniqueness for a given key. The client maintains an IV set
for each active send key and rejects a duplicate before encryption. The backend
independently applies the durable directional unique constraint
`(room_id, key_id, sender_key_id, iv)` and returns `e2ee_iv_reuse`. This second
check survives process reconnects. The client set is page-memory state, so a
reload relies again on 96-bit random generation plus the durable backend check.
A server-side rejection alone would be too late to prevent an observer from
seeing two ciphertexts created with one key/IV. This classroom slice does not
implement a persistent monotonic nonce allocator or enforce a formal per-key
invocation budget.

After an `e2ee_iv_reuse` response, the client pauses sending and marks the
local identity for rotation. The explicit retry action generates a replacement
room/profile key pair, discards old derived contexts, reconnects and requires
review of the new safety code. Rotation prevents continued use of the rejected
key/IV namespace; it does not add forward secrecy or recover the failed
message.

On authenticated-decryption failure, return no partial plaintext, show no
normal message bubble and enter a failed state. Never retry different plaintext
with the same key and IV.

## Persistence and acknowledgements

SQLite stores only encrypted envelopes and required clear metadata after
`e2ee_required` is active. The browser decrypts history locally when it retains
the matching identity key and can derive the matching pair context.

A page-session fallback key is lost on refresh, so earlier ciphertext may
become unavailable. The UI must say that the matching key is missing, not show
raw ciphertext or ask the backend for plaintext.

`message_ack` means the backend accepted the envelope for relay/persistence.
It does not prove that the peer received or decrypted it. The backend is not a
cryptographic endpoint and cannot validate message plaintext.

## Rekey and key-change meaning

This slice derives a new context when the advertised key pair changes. Sending
pauses, the prior local verification record no longer matches and both users
must compare the new code.

The locally remembered first peer key detects replacement across a reconnect
or room reopen. A user may explicitly accept the replacement to continue
encrypted but unverified; this updates only the local trust-on-first-use record.

This is not a Double Ratchet. The room/profile P-256 ECDH key is deliberately
persistent, and there are no fresh ephemeral DH keys per session or message.
Compromise of that private key plus recorded peer keys and context may expose
past ciphertext. Phase 4 therefore does not claim forward secrecy or
post-compromise security.

Retrying `e2ee_hello` with the same persistent key is setup recovery, not
cryptographic rekeying. A new HKDF label or context under the same long-term
ECDH secret would be key separation, not forward secrecy.

## Actual errors and fail-closed response

| Error | Meaning | Required client response |
| --- | --- | --- |
| `e2ee_required` | A plaintext command targeted a locked room. | Reject it; keep sending paused until an encrypted context exists. |
| `e2ee_public_key_conflict` | Both active clients advertised one key ID. | Fail setup; create a distinct local key. |
| `e2ee_not_ready` | Both current advertisements are not available. | Wait or retry hello; do not send plaintext. |
| `e2ee_key_mismatch` | Envelope `key_id` is not the current pair. | Fail current context and derive again from current keys. |
| `e2ee_iv_reuse` | The same room/pair/sender-key/IV tuple already exists. | Fail the message, pause sending and rotate the local identity on explicit retry before reviewing the new code. |
| `message_id_conflict` | One client ID was reused for different content. | Fail that optimistic item; create no silent duplicate. |
| `validation_error` | Strict schema or encoding validation failed. | Show a generic setup/message error without echoing unsafe content. |

Additional general WebSocket errors remain separate from encryption status.

Fail-closed rules:

- no automatic downgrade to plaintext;
- no plaintext `message` in an `e2ee_required` room;
- no send while setting up, key-changed or failed;
- no encrypted badge based only on server state;
- no verified badge based on a backend event;
- no IV reuse under one directional key;
- no display of unauthenticated plaintext;
- no acceptance of unknown versions, algorithms or extra fields;
- no private/derived key in JSON, SQLite, logs, URLs, analytics or errors;
- no use of Phase 3 simulated values in chat encryption; and
- no direct LAN HTTP browser client.

## Security goals

With a locally active context, Phase 4 aims to provide:

- confidentiality and integrity of message content against the relay and
  passive LAN observers;
- local detection of modified ciphertext and authenticated envelope fields;
- ciphertext-only backend storage;
- role-separated message keys;
- visible manual authentication of the current public-key pair; and
- explicit failure without plaintext fallback.

After a code comparison, the app may say that the current browser keys were
manually verified here. It must not say that an account, legal identity, device
health or future replacement key is verified.

## Non-goals and prohibited claims

This slice does not provide:

- physical QKD or quantum-derived chat keys;
- authenticated accounts, certificates or signed identity keys;
- an automatically authenticated key exchange;
- Noise, X3DH, a Double Ratchet or message ratcheting;
- forward secrecy or post-compromise security;
- protection from malicious local application code or endpoint compromise;
- metadata confidentiality, anonymity or traffic-analysis resistance;
- availability against a malicious relay;
- production TLS on the LAN relay; or
- a formal protocol proof or external security audit.

Do not use **quantum-secure chat**, **completely secure**, **unhackable**,
**forward secret**, **identity verified**, **server-proof**, **military-grade**
or **256-bit security**.

## Verification requirements

### Browser cryptography

- P-256 ECDH produces matching secrets in independent browser contexts.
- Raw-byte public-key ordering and backend `key_id` calculation match across
  implementations, including vectors where base64url ordering differs.
- Directional HKDF outputs are distinct and match only in the intended
  direction.
- Room, key pair, version and direction changes alter the intended context.
- AES-GCM known-answer, ciphertext, tag, IV and associated-data tamper tests
  pass without returning partial plaintext.
- Forced random-IV duplication is rejected before the second ciphertext is
  transmitted, and the backend constraint independently rejects reuse.
- The 12-digit safety-code algorithm has fixed cross-browser vectors and is
  symmetric between participant roles.

### Key lifecycle

- The private ECDH and derived AES `CryptoKey` objects are non-extractable.
- IndexedDB persistence works in the supported browsers on both target Macs.
- Forced IndexedDB failure selects the session fallback and exposes its warning.
- Refresh with a session key changes the public key/code and clears verification.
- Public-key change blocks send until explicitly accepted or verified.
- A remembered peer-key mismatch is detected after leaving and reopening the
  same room; accepting it updates the local pin but does not mark it verified.
- IV-reuse recovery rotates the local identity, discards old contexts and
  requires review of the replacement safety code.

### Backend and persistence

- First hello durably and irreversibly activates `e2ee_required`.
- Repository and WebSocket layers reject plaintext after the lock.
- The database stores decoded-size-valid ciphertext with tag, not plaintext.
- A database/log/public-event scan finds no known test plaintext or private key.
- `key_id`, `sender_key_id`, IV and message-ID conflicts are rejected exactly.
- Both LAN backend paths relay the same opaque encrypted envelope.

### Two-Mac behavior and UX

- Each Mac uses its own localhost frontend and the existing LAN backend relay.
- A direct `http://<LAN-IP>` browser path is blocked with setup guidance.
- Every visible state matches local cryptographic evidence.
- Unverified encryption never uses verified-person wording.
- Setup, changed-key and failures disable sending.
- No failure creates a plaintext message.
- Protocol Lab results never change the encryption state.

## Future hardening

A later phase may replace this custom synchronous exchange with a reviewed
authenticated protocol such as Noise XX. The current local peer-key pin is
only a trust-on-first-use continuity check, not an authenticated handshake.
It may add ephemeral handshakes, signed identities, QR verification, message
ratcheting, recovery and TLS. Those properties must remain absent from product
claims until implemented and independently reviewed.

## Primary references

- [Web Cryptography Level 2](https://www.w3.org/TR/webcrypto/) for P-256 ECDH,
  HKDF, AES-GCM, secure contexts, non-extractable `CryptoKey` behavior and web
  endpoint limitations.
- [NIST SP 800-56A Revision 3](https://csrc.nist.gov/pubs/sp/800/56/a/r3/final)
  for elliptic-curve key establishment.
- [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html) for HKDF.
- [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final) for AES-GCM
  and 96-bit IV guidance.
- [RFC 5116](https://www.rfc-editor.org/rfc/rfc5116.html) for AEAD nonce
  uniqueness and associated data.
- [Signal X3DH authentication guidance](https://signal.org/docs/specifications/x3dh/#authentication)
  for comparing identity-key fingerprints through a separate authenticated
  channel.
- [Signal Sesame security considerations](https://signal.org/docs/specifications/sesame/#security-considerations)
  for re-verification after a public identity-key change.
- [Noise Protocol Framework](https://noiseprotocol.org/noise.html) only as a
  possible future reviewed handshake, not as Phase 4 behavior.
