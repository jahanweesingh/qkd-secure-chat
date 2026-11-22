# Endpoint-owned BB84 contribution: protocol and implementation record

Status: **Endpoint-owned prototype implemented.** Both browser endpoints can
run the specified software simulation over the protected WebSocket relay,
confirm a matching contribution, and activate a hybrid chat-key epoch. ECDH-only
chat remains available. The room-hosted teaching simulation remains separate.
This implementation has not undergone an independent security audit and is
not a production QKD system.

## Existing system and design boundary

The room-hosted Python BB84 simulator creates both participants' candidate
sequences, performs the educational post-processing, discards its derived
output, and broadcasts an allow-listed report. The optional teaching seed is
public and makes a run reproducible. That output is not a chat key and must
never be promoted into one.

The existing chat remains a supported ECDH-only mode. Each browser derives
directional AES-256-GCM keys from the current P-256 ECDH secret and the existing
room/public-key-pair context. Its message format and history behavior remain
unchanged for that mode. The BB84 hybrid mode is opt-in and uses a distinct
version, run identifier and chat-key epoch. A BB84 failure never silently
changes the active mode or falls back to plaintext.

The backend is an untrusted-for-secrecy relay for the new control protocol. It
may validate bounded routing metadata and forward opaque envelopes, but it
must never receive a BB84 contribution, raw or reconciled key bits, a combined
KDF input, a confirmation key/tag outside its protected envelope, or a final
chat key. No endpoint may log or render those values.

## Endpoint roles and independent participation

Both users first opt in and locally confirm the existing full safety code for
the current public-key pair. The server cannot assert that either user has
verified the code. The browser with the lexicographically lower raw public key
is Alice for that run; the other is Bob. This deterministic assignment avoids
role ambiguity and is bound into the run transcript.

Alice's browser independently generates fresh preparation bits and bases with
Web Crypto. It forms a classical representation of each simulated state and
sends the bounded batches only inside the protected control channel. Bob's
browser independently generates measurement bases and computes simulated
outcomes from the received representation. Configured channel noise and
intercept-resend behavior are software rules. Bob's browser does not receive
Alice's private candidate buffer; Alice does not receive Bob's measurements
until the protocol messages disclose them. Both endpoints then retain their
own local candidate sequence and independently execute the agreed post-
processing.

This exchange is not a quantum channel. A browser necessarily represents the
simulated states as classical data, and an endpoint receiving that data can
inspect it. Encrypting those messages protects them from the backend and
network observers only under the existing ECDH assumptions. It does not model
quantum no-cloning and does not provide genuine quantum hardware QKD.

## Protected control channel and message schemas

Derive dedicated control-channel AEAD keys from the existing ECDH secret while
that secret is available in browser key setup. Use a new protocol/version
domain and separate `low-to-high` and `high-to-low` labels. Do not reuse the
chat AES keys for control packets. Each endpoint retains only its directional
control keys and its own protocol state. The concrete prototype fixes the
AEAD algorithm, nonce format, size limits, and canonical serialization in the
normative profile below; implementation must use its test vectors exactly.

All new messages use one dedicated `bb84_control` outer event, never ordinary
chat messages. The proposed envelope is:

```json
{
  "type": "bb84_control",
  "version": "bb84-endpoint-v1",
  "room_id": "room-code",
  "pair_key_id": "<current public-key-pair ID>",
  "run_id": "<fresh 128-bit random identifier>",
  "sender_key_id": "<registered sender public-key ID>",
  "recipient_key_id": "<registered peer public-key ID>",
  "sequence": 0,
  "nonce": "<canonical base64url AEAD nonce>",
  "ciphertext": "<canonical base64url authenticated ciphertext>"
}
```

The backend validates the event type, version, current room and pair routing,
active sender/recipient, identifier encodings, sequence bounds, nonce and
ciphertext sizes, then relays the envelope unchanged. It does not decrypt or
persist it. The relay does not decide whether a browser's state transition is
valid; each endpoint performs that validation.

The authenticated inner plaintext is a strict tagged union. The minimal
prototype's exact outer/inner schemas, fields and bounds are specified in the
normative profile below; the following table is an overview only. The outer
sequence is authenticated as AEAD associated data. The role is derived from
the registered key ordering rather than trusted from a payload field.

| Kind | Required payload | Purpose |
| --- | --- | --- |
| `run_offer` | normalized configuration, initiator role, starting transcript commitment | Propose one run. |
| `run_accept` / `run_reject` | accepted configuration hash or bounded reject reason | Record the other user's opt-in. |
| `qubit_batch` | batch index, preparation bases, classical state representation | Alice-to-Bob simulated transmission. |
| `measurement_batch` | batch index, Bob's bases and outcomes | Authenticated protocol disclosure to Alice. |
| `sample_commit` / `sample_reveal` | committed role-local random seeds | Jointly derive sample positions after basis exchange. |
| `sample_disclosure` / `sample_vote` | selected sample values, mismatch count and QBER | Both endpoints validate the sample decision. |
| `reconcile_parity` / `reconcile_reply` / `reconcile_flip` | bounded block range, parity and correction position | Reconcile local retained candidates. |
| `privacy_seed` | public Toeplitz seed and dimensions | Apply the same universal hash locally. |
| `key_confirm` | epoch ID and transcript-bound confirmation tag | Prove both sides derived the same candidate epoch. |
| `epoch_prepare` / `epoch_prepared` | epoch ID and transcript hash | Prepare activation without sending key material. |
| `epoch_commit` / `epoch_committed` | epoch ID and commit transcript hash | Complete idempotent activation exchange. |
| `abort` | bounded reason, last accepted sequence, transcript hash | Stop a run and bind failure to the observed transcript. |

All listed payloads are inside the control AEAD ciphertext. The backend sees
only the outer routing fields, packet sizes, timing, and ciphertext. Public
control values such as bases, sample positions, parity disclosures, and the
privacy-amplification seed are still confidential in transit in this software
design; none is sent as a separate plaintext event.

## Transcript, ordering, and replay protection

At run creation, bind the protocol version, room ID, pair-key ID, sorted raw
public-key IDs, Alice/Bob role assignment, run ID, normalized configuration,
and initial state into the transcript. Every accepted inner message includes
the previous transcript hash. Both endpoints use one specified canonical
encoding and hash the same ordered plaintext protocol records; the wire
ciphertext, nonce, and relay-added metadata are not substituted for the
protocol transcript. The exact encoding and hash algorithm are implementation
gates, not implementation details to guess independently.

Each sender uses a strictly increasing per-run sequence number and a fresh
AEAD nonce. A receiver accepts only the next expected sequence and valid next
state. An exact retransmission may be idempotently acknowledged only when its
sequence and authenticated content match the already accepted record; the
same sequence with different content is a fatal conflict. Older sequences,
unknown run IDs, stale pair IDs, changed configurations, bad previous hashes,
wrong roles, duplicate nonces, and out-of-order transitions abort the run.
Run IDs are generated with Web Crypto and are never reused by an endpoint.

## Simulation and post-processing

Both endpoints independently perform the following stages against their own
local data and the authenticated transcript:

1. **Prepare and measure:** Alice generates bits and bases; Bob independently
   selects bases and simulates measurements, including configured noise and
   intercept-resend behavior.
2. **Sift:** exchange basis choices and retain only matching-basis positions.
   Each endpoint derives the same ordered sift index list and checks its
   dimensions and batch commitments.
3. **Sample:** agree on sample positions, disclose only those sample values,
   calculate QBER independently, and apply the same configured threshold.
   A failed or undersized sample aborts.
4. **Reconcile:** exchange bounded Cascade-inspired parity messages. Each side
   updates only its own candidate buffer, counts disclosed parity leakage,
   enforces pass/work limits, and checks the final reconciliation condition.
5. **Privacy amplification:** independently calculate the agreed entropy
   bound, subtract disclosed reconciliation leakage and the specified margin,
   and use a shared public Toeplitz seed to hash the retained sequence to the
   agreed output length. If the defined bound is insufficient, abort. The
   fixed prototype parameters below use an educational asymptotic estimate,
   not a finite-key security proof.

The same run transcript and local candidate processing must produce identical
contribution bytes `C` at both browsers. `C` itself is never exchanged. A
mismatch is detected by key confirmation and causes abort; it must not be
repaired by sending or displaying either value.

## Final chat-key derivation and confirmation

The ECDH secret and `C` are both required inputs for the proposed BB84-mode
key schedule. The design does not claim security independent of ECDH: the
control channel that protects the simulation transcript is derived from ECDH,
and an attacker able to compromise or break that exchange can defeat the
confidentiality assumptions. The simulated contribution is not a quantum
secret and does not upgrade ECDH to quantum-secure cryptography.

After both endpoints finish post-processing, define one reviewed,
versioned, length-delimited encoding:

```text
IKM = Encode(
  label = "bb84-endpoint-v1/hybrid-input",
  ecdh_secret_length, ecdh_secret,
  contribution_length, C
)
salt = SHA-256(canonical_complete_run_transcript)
PRK = HKDF-Extract-SHA-256(salt, IKM)
```

The normative profile below fixes byte formats, lengths, hashes, and rejection
behavior. The BB84 session/report ID is public context, not secret input. Do
not XOR the inputs or use ambiguous concatenation.

Derive independent outputs from `PRK` with HKDF-Expand-SHA-256 and distinct
versioned labels bound to the room, pair, run, transcript hash, and epoch:

- `chat/low-to-high` and `chat/high-to-low`: separate AES-256-GCM message
  keys;
- `confirm/low-to-high` and `confirm/high-to-low`: separate key-confirmation
  keys.

The confirmation keys produce role- and direction-bound HMAC-SHA-256 proofs
over the pre-confirmation transcript hash `T_pre`, proposed epoch ID, protocol
version, and confirmation purpose. Only the proof is sent, encrypted inside the control
channel. Both endpoints verify the opposite proof in constant time. Proofs
are not chat keys and must never be logged or returned to the backend in
plaintext. Each browser keeps its chat keys as non-extractable Web Crypto
keys. A final key mismatch or confirmation failure aborts without activation.

## State machine, activation, and recovery

Each browser enforces this state machine independently:

```text
idle → awaiting_peer → simulating → sifting → sampling → reconciling
     → privacy_amplification → key_confirmation → epoch_prepared
     → epoch_committing → active

Any non-active state → aborted
ambiguous commit/disconnect → activation_uncertain (sending paused)
```

No endpoint may use the new keys before it has verified the peer's
transcript-bound confirmation and the agreed epoch. The prototype uses
`epoch_prepare`, `epoch_prepared`, `epoch_commit`, and `epoch_committed` with
exact retries. If commit status is uncertain, the endpoint pauses and
invalidates the run; reconnect never resumes it. Both users must start a new
run or explicitly select ECDH-only mode. A network protocol cannot guarantee
simultaneous remote knowledge under arbitrary partitions; the precise
fail-closed limit is specified below.

The epoch ID binds the protocol version, room, pair, run, transcript, mode,
and key-schedule version. Encrypted message envelopes and IV uniqueness
tracking must be epoch-aware in the future implementation. Existing history
must retain its original key context. Do not erase old ECDH or epoch material
until history retention and recovery are specified; if a browser cannot
restore an old key, report the history as unavailable rather than trying
another key.

On explicit user selection, a failed new-mode run may leave the conversation
using the existing ECDH-only mode. That is a mode choice, not automatic
fallback, and must be clearly shown. Failure cases include rejection, timeout,
disconnect, stale identity, sample/QBER failure, insufficient entropy,
reconciliation limit/failure, transcript disagreement, invalid/replayed
packet, missing contribution, confirmation failure, and uncertain commit.
Every such case leaves the BB84 epoch inactive. No path enables plaintext.

## Required implementation gates and tests

The normative profile below fixes the canonical schemas, AEAD/nonces,
transcript encoding, state transitions, KDF encodings and labels, and limits.
Before implementation, review those fixed values and produce cross-browser
known-answer vectors. Then implement in reviewed stages. Required automated
and integration coverage:

- two independent endpoints derive matching `C`, confirmation proofs, and
  directional chat keys from the same valid transcript;
- changed contribution, ECDH input, room, pair, role, run, transcript, or
  direction yields different keys or fails confirmation;
- malformed and tampered control packets fail authentication;
- replayed packets, conflicting duplicate sequences, nonce reuse, stale runs,
  and invalid state transitions are rejected;
- disconnects and reconnects at every transition cause each endpoint to pause,
  reject queued sends, and discard the old run on reconnect; retries are
  idempotent, and no endpoint resumes an uncertain epoch;
- failed samples, insufficient entropy, reconciliation failure, mismatched
  keys, and missing contributions cannot activate a key;
- backend events, SQLite, logs, UI, and diagnostics contain no known raw
  candidate bits, `C`, combined KDF input, confirmation keys, or final chat
  keys;
- existing ECDH-only chat, history, encryption, and downgrade protections
  continue to pass their regression coverage.

Independent protocol review is required before describing the new mode as
security-reviewed. A passing test suite is not a cryptographic proof.

## Security assumptions and limitations

The design assumes correct Web Crypto implementations, fresh browser
randomness, an uncompromised endpoint and same-origin application code, sound
protocol implementation, and out-of-band verification of the existing ECDH
public-key pair. Backend secrecy depends on proper control-envelope
encryption. The backend still sees participant/routing IDs, current public
keys, packet sizes, timing, room metadata, and encrypted chat envelopes.

This is classical software simulation, not physical QKD or quantum-secure
encryption. Simulation messages are classical and protected by ECDH; this
protocol adds no security independent of ECDH and makes no quantum no-cloning
claim. Persistent ECDH identity keys do not provide forward secrecy or
post-compromise security. Endpoint compromise or malicious same-origin code
can access plaintext or invoke keys. The entropy calculation is educational
unless replaced by a separately reviewed finite-key analysis. LAN relay TLS,
authenticated accounts, identity certificates, and a formal protocol audit
remain outside this design.

## Reference basis

## Minimal demonstration profile (normative corrections)

This section fixes a bounded two-laptop classroom prototype and supersedes
the earlier illustrative message fields, transcript wording and processing
choices above. It makes no cryptographic protocol-security claim and leaves
the current ECDH-only chat unchanged.

### Control keys, envelope, associated data, and replay

Use AES-256-GCM with a 96-bit nonce and 128-bit tag for control packets. For
each fresh 128-bit `run_id`, derive one key per direction from the browser's
existing ECDH secret:

```text
salt = SHA-256("bb84-endpoint-v1/control-salt\0" || pair_key_id_raw || run_id_raw)
K_control(direction) = HKDF-SHA-256(
  IKM = ECDH shared secret,
  salt = salt,
  info = "bb84-endpoint-v1/control/" || direction,
  L = 32 bytes
)
```

`direction` is exactly `low-to-high` or `high-to-low`, assigned by unsigned
lexicographic ordering of the raw 65-byte P-256 public keys. Never reuse a
chat AES key for control. The outer envelope has exactly these fields:

```json
{
  "type": "bb84_control",
  "version": "bb84-endpoint-v1",
  "room_id": "<1-64 ASCII characters>",
  "pair_key_id": "<43-character base64url SHA-256>",
  "run_id": "<22-character base64url 128-bit value>",
  "sender_key_id": "<43-character base64url SHA-256>",
  "recipient_key_id": "<43-character base64url SHA-256>",
  "sequence": 0,
  "nonce": "<16-character base64url 96-bit value>",
  "ciphertext": "<canonical unpadded base64url, including GCM tag>"
}
```

`sequence` is a sender's unsigned 64-bit integer, begins at zero per run and
direction, increments by one, and is represented as a safe JSON integer. The
prototype caps it at 65,535. The nonce is four zero bytes followed by the
sequence as unsigned 64-bit big-endian. Run- and direction-specific keys make
this nonce space unique. A retry retransmits the exact same envelope; it
never encrypts new content at a used sequence/nonce. Conflicting reuse aborts.

AEAD associated data is this binary length-prefixed encoding (integers are
unsigned big-endian), not ad-hoc JSON:

```text
ASCII("bb84-endpoint-v1/control-aad\0") ||
u16len(version) || UTF8(version) ||
u16len(room_id) || UTF8(room_id) ||
u16len(pair_key_id) || ASCII(pair_key_id) ||
u16len(run_id) || run_id_raw ||
u16len(sender_key_id) || ASCII(sender_key_id) ||
u16len(recipient_key_id) || ASCII(recipient_key_id) ||
u64(sequence)
```

The receiver reconstructs AAD from the envelope and current room/pair/peer
state before decryption. Room, pair, run, sender, recipient, version, or
sequence substitution therefore fails authentication. Plaintext is strict
UTF-8 JSON with exactly `{ "kind": <string>, "payload": <object> }`; the
kind-specific schemas below reject unknown fields. The complete outer frame
is at most 4,096 bytes and decrypted plaintext at most 2,048 bytes.

Only one run may be active per room. A receiver accepts only the current run,
pair, sender/recipient, and next expected sequence. An exact byte-for-byte
retransmission of the last accepted envelope is ignored without reprocessing;
the sender may retry only those exact bytes. Older sequences, conflicting duplicates, gaps,
repeated nonces, wrong IDs, and completed-run replays are rejected. Any
socket disconnect discards active/pending run state; reconnect requires a
fresh run ID. Run IDs use Web Crypto randomness and are never intentionally
reused.

### Complete inner message schemas and transitions

Payloads are closed schemas: shown fields are required, no extra fields are
allowed, and integer bounds are inclusive. Role is derived from registered
key ordering, never trusted from JSON. Size bounds are decoded sizes unless
stated otherwise.

| Kind / sender / allowed state | Exact payload |
| --- | --- |
| `run_offer` / Alice / `idle` | `qubit_count: 1024`; `noise_ppm: integer 0..250000`; `intercept_ppm: integer 0..1000000`; `qber_threshold_ppm: 110000`; `sample_fraction: "1/4"`; `reconciliation: "single-pass-block16-bisect-v1"`; `privacy_amplification: "toeplitz-gf2-128-v1"`. Fixed values/labels are mandatory. |
| `run_accept` / Bob / `awaiting_peer` | `config_hash: string`, exactly 43-char base64url SHA-256 of canonical offer payload. |
| `run_reject` / Bob / `awaiting_peer` | `reason: "user_declined"`, `"unsupported_version"`, or `"settings_mismatch"`. |
| `qubit_batch` / Alice / `simulating` | `batch_index: integer 0..15`; `states_b64: string`, exactly 22-char base64url encoding 16 bytes. Each of 64 qubits uses two MSB-first packed bits: basis (`0=Z,1=X`), then prepared bit. |
| `measurement_batch` / Bob / `simulating` | `batch_index: integer 0..15`; `measurements_b64: string`, same packing: measurement basis then outcome for each of 64 states. Must follow the matching `qubit_batch`. |
| `sample_commit` / either / `simulating` before any `qubit_batch` | `commitment: string`, 43-char base64url SHA-256 commitment to that role's 32-byte random seed, run ID, and role. One per role; both commitments precede all simulation batches. |
| `sample_reveal` / either / `sampling` | `seed_b64: string`, exactly 43-char base64url encoding 32 bytes; allowed only after both commitments and must match sender's commitment. |
| `sample_disclosure` / either / `sampling` | `indices: strictly increasing integer array` in `0..sifted_count-1`, exactly matching the jointly derived sample indices; `values_b64: string`, one MSB-first bit per index, zero-padded to `ceil(sample_count/8)` bytes. Both send the same indices and their own values. |
| `sample_vote` / either / `sampling` | `accepted: boolean`; `sample_count: integer 32..256`; `mismatches: integer 0..sample_count`; `qber_ppm: integer 0..1000000`, exactly `floor(1000000*mismatches/sample_count)`. `accepted` is true iff `sample_count>=32` and `qber_ppm<=110000`. Both votes must match all values. |
| `reconcile_parity` / Alice / `reconciling` | `query_id: integer 0..511`; `block_index: integer 0..47`; `start: integer 0..767`; `length: integer 1..16`; `alice_parity: integer 0..1`. Range must lie within that retained 16-bit block. |
| `reconcile_reply` / Bob / `reconciling` | `query_id: integer 0..511`; `parity_differs: boolean`, exactly whether Bob's parity for the queried range differs from `alice_parity`. Answers the next outstanding query exactly once. |
| `reconcile_flip` / Alice / `reconciling` | `query_id: integer 0..511` for the final length-one query; `position: integer 0..767`. Allowed only after bisection identifies one differing position; Bob flips that local bit. |
| `reconcile_done` / Alice / `reconciling` | `query_count: integer 0..512`; `leaked_bits: integer 0..1024`, exactly `2*query_count`. Bob validates and replies `reconcile_ack`. |
| `reconcile_ack` / Bob / `reconciling` | Same `query_count` and `leaked_bits`; must match Alice's counts. |
| `privacy_seed` / Alice / `privacy_amplification` | `input_bits: integer 1..768`; `output_bits: 128`; `seed_bits: integer input_bits+127`; `toeplitz_seed_b64: string` with exactly `ceil(seed_bits/8)` decoded bytes and zero padding. |
| `privacy_vote` / either / `privacy_amplification` | `accepted: boolean`; `estimated_secret_bits: integer 0..768`; `output_bits: 0 or 128`. Both must accept with 128 output bits. |
| `key_confirm` / either / `key_confirmation` | `preconfirm_hash` and `epoch_id`: each 43-char base64url SHA-256; `tag`: 43-char base64url 32-byte HMAC-SHA-256. |
| `epoch_prepare` / Alice / `epoch_prepared` | `preconfirm_hash`, `confirm_hash`, `epoch_id`: each 43-char base64url SHA-256. |
| `epoch_prepared` / Bob / `epoch_prepared` | Same fields; must exactly match Alice's. |
| `epoch_commit` / Alice / `epoch_committing` | `confirm_hash`, `epoch_id`: each 43-char base64url SHA-256. |
| `epoch_committed` / Bob / `epoch_committing` | Same fields; Bob sends only after validating commit. |
| `abort` / either / any state, including `active` | `reason` is one of `declined`, `timeout`, `disconnect`, `invalid_message`, `replay`, `sample_failed`, `insufficient_entropy`, `reconciliation_failed`, `key_mismatch`, `confirmation_failed`, `activation_uncertain`. Receiving abort immediately disables that run's epoch. |

Normal order: Alice offer; Bob accept; both sample commits; sixteen ordered
qubit/measurement batch pairs; both reveals; both disclosures; both votes;
zero or more Alice parity queries/Bob replies and Alice flips; reconcile
done/ack; Alice privacy seed; both privacy votes; both key confirmations;
Alice prepare/Bob prepared; Alice commit/Bob committed. Any omitted, extra,
repeated, or out-of-state message aborts. Reject/abort ends the run. No
backend event may advance endpoint state. For this minimal UI, only the
Alice-role browser offers/starts a run; Bob opts in by accepting that offer.

### Exact transcript boundary, key schedule, and confirmation

Use RFC 8785 JSON Canonicalization Scheme (JCS), UTF-8, and no floating-point
values. Each transcript record is exactly `{role, sequence, kind, payload}`;
role is the derived string `alice` or `bob`, and sequence is the authenticated
outer integer. The pre-confirmation record set includes `run_offer` through both
`privacy_vote` records, inclusive. It excludes key-confirmation and all epoch
messages, retransmission copies, outer nonces/ciphertexts, and routing-only
fields. Fixed phase order is `run_offer`, `run_accept`, `sample_commit`,
`qubit_batch`, `measurement_batch`, `sample_reveal`, `sample_disclosure`,
`sample_vote`, `reconcile_parity`, `reconcile_reply`, `reconcile_flip`,
`reconcile_done`, `reconcile_ack`, `privacy_seed`, `privacy_vote`; within each
kind sort Alice before Bob, then sender sequence. Define:

```text
T_pre = SHA-256(
  ASCII("bb84-endpoint-v1/preconfirm\0") || run_id_raw || JCS(records)
)
```

Both `key_confirm` messages carry this exact `T_pre`; confirmation and
activation records therefore cannot be inputs to the keys they authenticate.
The contribution `C` is the 128 Toeplitz output bits packed MSB-first. Define
the key schedule exactly as:

```text
IKM = ASCII("bb84-endpoint-v1/hybrid-input\0") ||
      u16be(32) || ECDH_secret_32 || u16be(16) || C_16
PRK = HKDF-Extract-SHA-256(salt=T_pre, IKM=IKM)
epoch_id = SHA-256("bb84-endpoint-v1/epoch\0" || pair_key_id_raw || run_id_raw || T_pre)
```

HKDF-Expand-SHA-256 from `PRK` uses four separate info values:
`bb84-endpoint-v1/chat/low-to-high\0`,
`bb84-endpoint-v1/chat/high-to-low\0`,
`bb84-endpoint-v1/confirm/low-to-high\0`, and
`bb84-endpoint-v1/confirm/high-to-low\0`, each followed by `u16be(room byte
length) || UTF8(room) || epoch_id_raw`. Chat keys and confirmation keys are
32 bytes. Let role byte be `0` for Alice and `1` for Bob. Each confirmation
tag is HMAC-SHA-256 over
`ASCII("bb84-endpoint-v1/key-confirm\0") || T_pre || epoch_id_raw || role_byte`
using that sender's directional confirmation key. Verify the peer's tag in
constant time. The `confirm_hash` field is the base64url-no-padding encoding
of `T_confirm`. Define `T_confirm = SHA-256(ASCII("bb84-endpoint-v1/confirmed\0") || T_pre || JCS([Alice_key_confirm_record, Bob_key_confirm_record]))`.
Define `T_activation = SHA-256(ASCII("bb84-endpoint-v1/activation\0") || T_confirm || JCS([Alice_epoch_prepare, Bob_epoch_prepared, Alice_epoch_commit, Bob_epoch_committed]))`.
Those post-confirmation hashes bind activation but are not fed back into
HKDF. The epoch ID is fixed from `T_pre`.

### Fixed educational BB84 and processing parameters

- Exactly 1,024 simulated states in 16 ordered batches of 64. Each endpoint
  uses Web Crypto randomness. For each state, `intercept_ppm` selects
  intercept-resend with probability `intercept_ppm/1,000,000`. Eve chooses a
  uniform random Z/X basis: matching Alice's basis returns Alice's bit;
  otherwise Eve's bit is uniform random. Eve resends that basis/bit state to
  Bob. Bob measures it: matching bases preserve the resent bit; differing
  bases yield a uniform random bit. Without interception Bob measures Alice's
  state by the same matching or uniform-random rule. Finally `noise_ppm`
  independently flips Bob's outcome with probability `noise_ppm/1,000,000`.
  These are teaching rules, not a physical channel.
- Sift matching bases. For `s` sifted bits, disclose `floor(s/4)` positions
  without replacement and require at least 32 sample bits. Each endpoint
  contributes a committed random 32-byte seed. Commitment is
  `SHA-256("bb84-endpoint-v1/sample-commit\0" || run_id_raw || role_byte || seed)`.
  Reveal only after both commits. Sample ranking seed is
  `SHA-256("bb84-endpoint-v1/sample-rank\0" || run_id_raw || Alice_seed || Bob_seed || basis_transcript_hash)`, where `basis_transcript_hash = SHA-256("bb84-endpoint-v1/bases\0" || run_id_raw || Alice_basis_bits_packed || Bob_basis_bits_packed)` and each 1,024-basis vector is packed MSB-first in 128 bytes.
  Rank index `i` by
  SHA-256(sample_seed || u32be(i)); select the first `floor(s/4)`, tie-break
  by index, then both disclose their values. `qber_ppm` is
  `floor(1,000,000*mismatches/sample_count)`. Abort above 110,000 ppm QBER.
- Reconcile retained bits in original sift order, blocks of 16. Alice
  discloses each block parity. If it differs, Alice bisects by disclosing
  left-half parity until one position is located. Each split uses
  `left_length=floor(length/2)`; choose left when the reply says parity
  differs, otherwise right. Bob flips the located local bit.
  One pass only; at most 512 parity queries and 48 blocks. Conservatively
  count Alice's disclosed parity and Bob's `parity_differs` reply as two
  transcript leakage bits per query. There is no recursive look-back or
  second pass. Residual mismatches remain possible and key confirmation
  catches them; mismatch aborts.
- Let `n` be retained bits, `L=2*query_count` transcript leakage bits (Alice
  parity plus Bob's parity-difference reply for each query), and `q` sampled
  QBER.
  With `h2(q)=-q log2(q)-(1-q)log2(1-q)` and endpoint values `h2(0)=h2(1)=0`,
  use `estimated=max(0,floor(n*(1-h2(min(q,0.5)))-L-32))`. This is an
  illustrative asymptotic heuristic, not a finite-key security bound. Abort
  unless it is at least 128.
- Alice generates `n+127` fresh Toeplitz seed bits and sends them inside the
  control channel. Interpret bits MSB-first. For output index `i=0..127` and
  input index `j=0..n-1`, matrix entry is `seed[i+n-1-j]`; output `i` is the
  GF(2) dot product with the retained input. Both independently compute
  exactly 128 bits. Confirmation mismatch aborts; no contribution is sent.

This profile is random per run and has no public key-producing seed. Sampling
and entropy calculations are educational assumptions, not a proven secure
key-agreement protocol. The simulated contribution provides no security
independent of ECDH.

### Fail-closed activation and network limit

An endpoint activates only after validating both key-confirmation tags, the
matching preparation, and matching `epoch_committed`. It must not encrypt,
queue, or persist a message under the proposed epoch before then. It pauses
sends during prepare/commit. Timeout, socket close, changed pair, missing
acknowledgement, replay, or uncertainty locally invalidates the pending epoch
and sends `abort` if possible. It never reactivates that run after reconnect;
both users start a fresh run or explicitly select ECDH-only mode. Pending
BB84-mode messages are discarded; a receiver rejects BB84-epoch messages
unless locally active.

No asynchronous protocol can make two disconnected browsers learn
instantaneously that the other is uncertain. Each endpoint stops when it
detects uncertainty; its peer stops when it receives authenticated abort.
Any connection loss forces both to discard the run on reconnect, and neither
accepts the old epoch afterward. During a partition no packet is treated as
delivered to the peer. A literal guarantee that an unaware remote endpoint
stops before it can detect a one-way failure is impossible without an
additional trusted coordination/liveness assumption. This demo adds no
backend key authority and does not claim that stronger guarantee.

Required tests include matching/mismatched keys, header/AAD modification,
nonce/sequence reuse, exact retry, stale-run replay, transcript cutoff and
tag verification, lost commit acknowledgement, disconnect at every
transition, reconnect rejection of old epoch, discarded pending messages,
and ECDH-only regression. This documentation update does not run tests.

The existing browser primitives follow the [Web Cryptography specification](https://www.w3.org/TR/webcrypto/).
The proposed extract/expand schedule follows [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)
only after the application-specific encodings and labels are fixed and
reviewed. Neither reference certifies this protocol or its implementation.
