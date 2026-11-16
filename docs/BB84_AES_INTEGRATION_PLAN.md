# BB84 contribution: design decision and implementation plan

Status: **not implemented**. This upgrade preserves the working `e2ee-v1`
ECDH-only chat. The BB84 Security Lab remains separate. No new cryptographic
mode, wire event, key export, or key activation is introduced.

## Why integration is deferred

The current Python simulator owns both Alice's and Bob's candidate sequences.
`run_post_processing` consumes those buffers, reconciles them, hashes them,
checks agreement, derives a demonstration output, and clears its temporary
buffers. Only an allow-listed metrics report leaves the processor. A supplied
teaching seed makes those internal values reconstructible.

Encrypting this server-generated output for transport would not remove the
server's prior knowledge of it. Mixing a known contribution with a secret ECDH
input need not reveal the final AES keys, but it supplies no independent secret
against that server. It would not meet the requested endpoint-owned simulation
design. Sending that output directly, or relabeling a random browser value as
BB84 output, is explicitly rejected.

A browser-owned demonstration needs a versioned encrypted control protocol,
endpoint simulation, agreement on the transcript, authenticated key confirmation,
atomic activation, and history/reconnect handling. The current `key_id` identifies
only the public-key pair and room; it cannot distinguish two BB84 epochs under
the same pair. Reusing it for new AES keys would break history selection and
nonce accounting. This is a substantial protocol change, not a safe dashboard
patch. The following is a proposed design for review, not an audited protocol.

## Current key lifecycle

1. Each browser loads or creates a P-256 identity scoped to protocol version,
   room and normalized display name. Its non-extractable private key stays in
   IndexedDB, or in page memory if persistence fails visibly.
2. Public keys and their hashes cross the WebSocket relay. The first accepted
   advertisement durably locks the room against plaintext messages.
3. Each browser combines its private key with the other's public key using ECDH.
   The resulting shared secret stays in the browser.
4. HKDF-SHA-256 binds the room and raw-byte-ordered public-key pair, and uses
   separate `low-to-high` and `high-to-low` labels to derive AES-256-GCM keys.
5. Users compare the complete 12-digit safety code through a different trusted
   channel. Until then, key substitution by an active relay remains possible.
6. Each message uses a fresh random 96-bit IV and authenticated context. The
   backend validates the envelope and persists ciphertext and routing metadata.
7. History decryption requires the matching browser identity and peer key.
   Key replacement pauses sending; an IV-reuse rejection requires identity
   rotation on explicit recovery. No failure enables plaintext fallback.

## Proposed endpoint-owned demo

Keep ECDH-only rooms as a separate supported mode. Do not change v1 semantics.

### Generate and protect

Require both users to opt into the new mode and independently confirm the
current safety code first. Verification cannot be asserted by the server.
Each endpoint generates fresh randomness using Web Crypto; public teaching
seeds are forbidden for key-producing runs.

Alice's browser owns the simulated preparation sequence. Bob's browser owns
its measurement choices. A browser simulation necessarily represents quantum
states as classical data: transmit that representation only inside a dedicated
AEAD-protected control channel derived from the existing ECDH secret, with new
domain-separated labels. Bob's honest simulator applies measurement/noise/Eve
rules. Eve here is a teaching parameter, not a real quantum adversary. An
endpoint receiving a classical representation can inspect it; this cannot
reproduce quantum no-cloning or measurement security.

Exchange basis choices, sampling choices, reconciliation messages and public
hash seeds through that authenticated encrypted control channel. Bind every
packet to version, room, sorted peer identities, roles, a fresh joint run ID,
sequence number, configuration and transcript hash. Reject replay, duplicates
with conflicting content, out-of-order state transitions and stale identities.
Never reuse ordinary text messages as control packets or render their payloads.

### Consume locally

Both browsers must independently validate the sample decision, reconcile their
local retained candidates, perform the same privacy-amplification calculation,
and confirm the same result. Each locally obtains the same contribution `C`;
the final contribution is never sent in plaintext, logged or shown in the UI.
Internal simulation data is transferred only inside the protected endpoint
channel. The relay receives opaque control envelopes and public routing IDs.

The candidate key schedule would use a length-delimited, versioned encoding of
both the ECDH shared secret and `C` as HKDF input, a transcript-bound salt, and
separate labels for each message direction and confirmation key. Define exact
byte encodings and cross-language known-answer vectors before implementing it.
Do not XOR arbitrary values or use the BB84 report/session ID as secret input.
The HKDF construction requires review; this sketch is not a security proof.

### Confirm, activate and retain history

Use a new epoch identifier bound to the pair, joint run, mode and transcript.
Exchange authenticated prepare/confirm/commit acknowledgements proving both
endpoints derived the same epoch keys. Freeze new sends during activation;
never let one browser silently change keys while its partner uses the old epoch.
Handle lost acknowledgements idempotently. A timeout, failed sample, insufficient
entropy, mismatched transcript, missing contribution or key replacement must
leave the new mode inactive with an explicit failure. Continue the old mode only
as an explicit, clearly labeled user choice; never imply the rejected key is used.

Version and extend server schemas, envelope validation, pair/epoch routing,
database migrations, IV uniqueness namespaces, retry reconciliation and strict
frontend parsers together. Preserve v1 rooms. Store any history recovery package
only encrypted to endpoint-owned keys, with an explicit retention policy. Do not
erase old epoch keys until the history behavior is defined and tested. A browser
that cannot restore an epoch must show unavailable history, not guess a key.

## Required implementation gates

1. Review the threat model, exact transcript encoding and state machine.
2. Port the simulator/post-processing into endpoint modules and compare against
   Python's known vectors without exporting private inputs in production.
3. Test directional key agreement, context separation, tamper, replay, concurrent
   starts, mismatched configuration, failed/seeded runs and missing contributions.
4. Test two-phase activation, reconnect at every transition, retries, key change,
   history after refresh, browser storage failure and directional nonce reuse.
5. Scan public events, SQLite, logs, UI and diagnostics for known test secrets.
6. Exercise two independent browsers and the two-backend LAN relay; retain the
   complete ECDH-only regression suite. Obtain independent protocol review.
7. Only then display “BB84 key contribution: Active in demo mode” after both
   endpoints confirm activation. A successful sample alone never earns it.

## Limitations, including after a future implementation

This is classical software, not physical QKD or quantum-secure encryption.
Simulation over an ECDH-protected channel inherits that channel's security;
it does not add quantum guarantees. Persistent P-256 identities still have no
forward secrecy or post-compromise security. Endpoint compromise exposes
plaintext. Manual key verification is required; names remain self-asserted.
The asymptotic entropy estimate is educational, not a finite-key security proof.
Timing, room, participant and size metadata remain visible. The LAN hop still
needs production TLS and a reviewed deployment before public use.

## Reference basis

The existing browser primitives follow the [Web Cryptography specification](https://www.w3.org/TR/webcrypto/).
The proposed derivation must follow [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)
with explicit context and direction separation. Neither reference certifies
this application or the proposed hybrid protocol.
