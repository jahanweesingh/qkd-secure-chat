# Phase 4 E2EE and Protocol Lab Architecture

## Optional hosted runtime (14 November 2026)

The [free Render deployment](FREE_HOSTING.md) compiles the existing React app
and serves its static files from `backend/app/hosted.py`, alongside the existing
FastAPI API and WebSocket routes. One container and one Uvicorn worker share
room state. Render provides public HTTPS/WSS; local Docker still uses Nginx.

`DEPLOYMENT_MODE=hosted` requires exact allowed origins, returns an explicit
hosted `/api/network` response, and blocks LAN invitation relay before any
outbound connection. Browsers create 80-bit random online room codes and use
the same public website. It does not change encrypted envelopes or key
derivation. The hosting provider sees the same ciphertext and metadata as the
local relay. Browser code delivery remains trusted; safety-code comparison is
still necessary to authenticate the public-key exchange.

Render Free uses temporary SQLite and media storage: sleep, restart or redeploy
can discard them. This is a classroom demo deployment, not durable messaging.
The room-hosted BB84 teaching run remains separate from chat keys. An additional
endpoint-owned browser simulation can establish a hybrid chat-key epoch after
both endpoints confirm the contribution.

> **Editorial UI update (13 November 2026):** the text-only `CafeWelcome` wrapper
> reuses the existing join form. `cafe-workspace.css` owns the masthead,
> conversation and responsive Room notes drawer. The encryption studio has a
> control rail beside its results, and the BB84 walkthrough has a stage index
> beside its result sheet. These are presentation changes; key ownership and
> network contracts remain unchanged. See [TASTE_UI_REFINEMENT.md](TASTE_UI_REFINEMENT.md).

> **Simple encryption demo (13 November 2026):** one **Encryption demo** entry
> replaces repeated explanations in the chat. **Learn with keys** performs real
> ECDH/HKDF/AES operations with fresh, deliberately visible demonstration keys
> entirely in one browser. **Live chat** inspects actual chat envelopes and
> backend acknowledgements. The demo engine never supplies chat keys or sends
> its keys to the backend. See [SIMPLE_ENCRYPTION_DEMO.md](SIMPLE_ENCRYPTION_DEMO.md).

> **Live presentation update (13 November 2026):** the browser now keeps a bounded,
> local-only record of actual encryption operations for the live security view.
> BB84 comparison presets and redacted transmission review reuse existing results.
> No cryptographic or WebSocket format changed. See [LIVE_SECURITY_VIEW.md](LIVE_SECURITY_VIEW.md).

> **Encrypted media update (12 November 2026):** images and videos now use a
> fresh browser AES-GCM file key, opaque HTTP storage and a key-bearing descriptor
> protected by the existing chat envelope. See [ENCRYPTED_MEDIA.md](ENCRYPTED_MEDIA.md)
> for the capability gate, key lifecycle, quotas and limitations. Text key
> establishment and the independent BB84 simulation remain unchanged.

## Beginner lab presentation (November 2026)

`ProtocolLab` retains the existing settings, modal, API and diagnostics.
`SecurityLabWalkthrough` presents seven review steps using only the validated
`Bb84Result` aggregates and redacted trace. The host returns one `bb84_result`;
there are no live per-stage events. Pending work is indeterminate. Numbered
progress after receipt describes the user's review position, not elapsed
computation. A new session resets the review; local control edits do not change
the recorded result. A partner's result is presented identically.

`ChatProtectionSummary` reads `EncryptionInfo` from `useChat`. A successful lab
run cannot set an encryption or verification badge. Sample acceptance and
complete post-processing remain distinct; incomplete post-processing means no
usable simulated key. Detailed algorithms and diagnostics remain in disclosures.

The backend now shields disconnect cleanup against ASGI cancellation and bounds
the cleanup/presence send to two seconds. This prevents a cancelled WebSocket
handler from retaining stale participants or advertised keys.

The endpoint-owned BB84 integration adds a dedicated `bb84_control` relay event
and browser state machine. See [BB84_AES_INTEGRATION_PLAN.md](BB84_AES_INTEGRATION_PLAN.md)
for the protocol profile, implementation boundaries and remaining security
limitations. The original room-hosted teaching report remains a separate flow.

## Runtime layout

```text
Browser A                       Browser B
P-256 + AES-GCM              P-256 + AES-GCM
    |                               |
    +-- public keys and ciphertext -+
                    |
             Nginx / FastAPI
              localhost 8080
                    |
        creator room authority + SQLite
             /                 \
 ciphertext envelopes      BB84 simulator
                                  |
                         Phase 3 processor
                                  |
                         redacted metrics
```

Nginx serves the React interface and forwards `/api` and `/ws` to FastAPI.
Each browser creates its own P-256 ECDH identity. In ECDH-only mode it derives
directional AES-256-GCM keys with HKDF-SHA-256 from ECDH. In confirmed hybrid
mode it combines ECDH with the locally derived endpoint-owned BB84 contribution
before deriving directional keys. FastAPI validates room input and opaque E2EE
envelopes, forwards bounded encrypted BB84 control envelopes without opening
them, manages live connections, stores ciphertext plus routing metadata, and
produces the separate Phase 3 educational report.

## Endpoint-owned BB84 mode (implemented prototype)

The separate `bb84_start`/`bb84_result` path above remains the
backend-owned teaching lab. The optional BB84 chat mode is specified in
[BB84_AES_INTEGRATION_PLAN.md](BB84_AES_INTEGRATION_PLAN.md); it does not reuse
the backend-generated teaching result. In this mode, Alice and Bob independently
participate in a browser simulation. Alice generates preparation bits/bases;
Bob independently generates measurement bases/outcomes; they locally retain
and process their own candidate data. Required classical simulation data is
sent only inside a dedicated AEAD-protected control channel derived from the
existing ECDH secret.

The backend behavior is limited to validating bounded routing fields
and forwarding an opaque `bb84_control` envelope. It does not decrypt or store
control payloads, candidate bits, the BB84-derived contribution, combined KDF
input, confirmation keys, or final chat keys. The control protocol binds each
packet to the room, current pair, roles, configuration, run, sequence, and
transcript; endpoints enforce ordering, replay rejection, and state transitions.
Sifting, sampling, reconciliation, privacy amplification, and key confirmation
are independently checked by both browsers.

After both endpoints derive the same local contribution, they derive
transcript-bound, directional chat keys and separate confirmation keys using
HKDF-SHA-256 over a versioned encoding of both the existing ECDH secret and
the BB84-derived contribution. This is not security independent of ECDH: ECDH
protects the simulated exchange, and the design provides no genuine quantum
security. A new key epoch is activated only after both sides confirm it. An
abort or uncertain disconnect immediately pauses the detecting endpoint; an
authenticated abort pauses its peer when received. Any connection loss
invalidates the run, and reconnect requires a fresh run or explicit ECDH-only
selection. Pending BB84-mode messages are discarded. A remote browser cannot
learn instantly about a one-way failure; the protocol does not claim
simultaneous fail-stop behavior under arbitrary partitions. The ECDH-only chat
remains a separate supported mode with its current contract.

The bounded demonstration profile is fixed at 1,024 states in batches of 64,
quarter sampling with a 32-bit minimum sample, one 16-bit-block parity/bisection
pass, an illustrative binary-entropy estimate with a 32-bit margin, and a
128-bit Toeplitz output. Exact control schemas, AES-GCM AAD/nonce rules,
pre-confirmation transcript cutoff, KDF labels, and transitions are specified
in the integration plan; these settings are educational assumptions, not a
finite-key security proof.

## Phase 4 chat flow

```text
Browser A              Creator authority              Browser B
    |-- e2ee_hello ---------->|                            |
    |<------ e2ee_public_key ----------------------------->|
    |                            |<------ e2ee_hello -------|
    |<---------------- e2ee_public_key --------------------|
    | derive ECDH + HKDF      |       derive ECDH + HKDF   |
    | compare 12-digit safety code through trusted channel |
    |-- encrypted_message --->|-- encrypted_message ------>|
    |<------ message_ack -----|                            |
```

Private ECDH and derived AES keys never cross the browser boundary. The
backend injects `sender_key_id` from the active advertisement, checks the
current raw-byte-sorted public-key pair, rejects duplicate IVs in the
directional `(room_id, key_id, sender_key_id)` namespace and stores no `text`
field for an encrypted row. Acknowledgement means accepted for persistence and
relay, not peer decryption.

The safety code and verification record are entirely local. Before users
compare all 12 digits, ECDH protects against passive observation but does not
prevent an active relay from substituting keys. The current persistent
room/profile key design has no Noise handshake, Double Ratchet, forward
secrecy or post-compromise security.

The browser stores the identity key pair, including its non-extractable private
`CryptoKey`, in IndexedDB for the current protocol version, room and normalized
display-name profile.
When structured-clone persistence is unavailable, it uses a visible
page-session memory fallback. Losing that key can make earlier ciphertext
unavailable and changes the safety code; the backend cannot recover plaintext.

## Protocol flow

```text
Participant          Creator room authority             Both dashboards
     |                         |                                |
     |---- bb84_start -------->|                                |
     |                         | simulate BB84 + sample QBER    |
     |                         |                                |
     |                         | if BB84 aborted: skip Phase 3  |
     |                         | otherwise:                     |
     |                         |  reconcile candidate bits      |
     |                         |  account for parity leakage    |
     |                         |  estimate usable material      |
     |                         |  apply Toeplitz hash           |
     |                         |  confirm with HMAC              |
     |                         |  derive with context HKDF      |
     |                         |  discard derived material      |
     |<-------------------- bb84_result ----------------------->|
```

One per-room gate prevents concurrent experiments. A guest request sent through
the dual-Mac relay is executed by the creator authority, so both browsers
receive one identical result.

## Private and public data

The BB84 engine holds Alice's and Bob's undisclosed candidate sequences in an
internal object. They are passed directly to the post-processing function.
Neither the internal object nor the processor's private output has a generic
JSON serializer.

The public payload is built from an explicit allow-list and includes:

- experiment configuration and aggregate BB84 metrics;
- the accepted or aborted QBER decision;
- at most 24 redacted teaching-trace rows;
- reconciliation counts and leakage;
- the illustrative entropy estimate and privacy-amplification output length;
- confirmation success and derivation metadata; and
- explicit flags saying that no key bytes were serialized, retained or used
  for chat.

It excludes raw bits, reconciled sequences, Toeplitz seed material,
privacy-amplified bits, HKDF salt, HMAC tags and derived bytes. Protocol
results are ephemeral and are not replayed from SQLite.

This output boundary is not a secrecy proof. In particular, a supplied teaching
seed and all settings are public. The deterministic algorithm lets anyone with
that event, its room/session context and the source reconstruct the seeded
transcript and derived values. For that case, `key_material_exposed: false`
means only that key bytes were not serialized as fields in the report.

## Post-processing model

### Reconciliation

The model performs bounded, Cascade-inspired parity passes. Alice and Bob
compare block parity. A mismatching block is narrowed through additional
parity comparisons until one simulated error is corrected. Later permuted
passes expose errors hidden by even parity. Every parity comparison increments
the leakage count.

This is an educational model, not a drop-in implementation of a formally
specified reconciliation protocol. Remaining-error counts are available only
because the simulator knows both sequences.

### Privacy amplification

The processor estimates remaining secret material with an explicitly named
illustrative asymptotic BB84 binary-entropy model:

```text
floor(n × (1 - h2(min(Q, 0.5))) - reconciliation parity leakage - 32)
```

The estimate is clamped from zero through `n`. Here, `n` is the retained input
count after the disclosed sample has already been removed, and `Q` is sampled
QBER. The 128-bit confirmation tags remain internal and are not counted as
public leakage in this model. Small or disturbed runs can therefore finish
BB84 sampling successfully but stop with `insufficient_entropy`.

When at least 128 estimated bits remain, a Toeplitz universal hash compresses
the reconciled sequence to 128 bits. HKDF is not used as a substitute for
privacy amplification.

### Confirmation and derivation

Alice and Bob's modeled outputs produce separate truncated HMAC-SHA-256
confirmation tags. They are compared in constant time. A confirmed value is
then passed through HKDF-SHA-256 with protocol version, room ID and unique
session ID in its context.

`confirmation_failed` and `derivation_failed` are defensive
internal-consistency paths. Once reconciliation verifies equal candidates, the
same deterministic confirmation and derivation code should agree. An
unexpected mismatch therefore stops the pipeline and reports a fault rather
than representing an ordinary channel outcome.

HKDF expands the 128-bit privacy-amplified value into a 256-bit demonstration
output, but does not increase its entropy or security strength beyond the
input. The output exists only long enough to verify the processing path. It is
discarded and never sent to the browsers or message layer.

## Trust and security boundary

For Phase 4 chat, the two browser endpoints are trusted with plaintext. The
creator backend, SQLite, LAN relay and passive network observers receive
ciphertext plus visible room, self-entered identity, public-key, timing,
presence and size metadata. A compromised endpoint or same-origin application
script can still read plaintext or ask a non-extractable key to operate.
`extractable: false` is not a hardware-security guarantee.

Public keys and display names are self-asserted. The backend never reports a
peer as verified. Until the complete locally derived safety code is compared
through a different trusted channel, an active relay can substitute keys and
perform a man-in-the-middle attack. Both Macs therefore load their own
`http://localhost:8080` page. A browser page opened from another Mac's plain
LAN HTTP address is unsupported; the backend-to-backend classroom relay itself
still has no TLS.

Separately, the creator backend temporarily knows both simulated Protocol Lab
candidates and derived demonstration material. The optional seed is public and
intended for repeatable teaching, not secure randomness. A seeded run is
reconstructible by anyone with the event, shared room/session context and
source, so its simulated values provide no secrecy. The lab is neither
physical QKD nor a source of chat keys.

## Dual-host LAN flow

Each Mac runs its own Nginx, FastAPI service and SQLite volume, while both
browsers stay on `http://localhost:8080`.

```text
Mac A browser                              Mac B browser
localhost:8080                             localhost:8080
      |                                          |
Mac A Nginx + FastAPI <--- WebSocket relay --- Mac B FastAPI
      |
Mac A SQLite and room authority
      +-- ciphertext chat history
      |
      +-- BB84 + Phase 3 post-processing
```

An invitation contains the creator's validated RFC1918 IPv4 address. The
joining backend opens one bounded relay connection. The creator remains
authoritative for room capacity, ciphertext message history, E2EE room lock
and the complete protocol experiment. The relay provides routing only; it does
not authenticate browser public keys or add transport encryption. Each browser
still performs its own ECDH, safety-code calculation, encryption and
decryption.

## Portability

The project uses Linux containers and runs on Intel, AMD and Apple Silicon
Docker hosts. Local mode binds port 8080 to `127.0.0.1`.
`scripts/start_lan.sh` validates an RFC1918 address, binds the frontend to
`0.0.0.0` and publishes the selected address through `GET /api/network`.
That public bind lets the other backend reach the relay endpoint; it does not
make direct plain-HTTP browser loading a supported Phase 4 path.
