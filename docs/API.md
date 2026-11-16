# Phase 4 API Contract

## Health

`GET /api/health`

Returns the service and database health state.

## Room history

`GET /api/rooms/{room_id}/messages?limit=50`

Returns the room ID, oldest-to-newest recent chat records, participants
connected to this server process, and `e2ee_required`. A Phase 4 record is an
opaque encrypted envelope and never contains `text`. Plaintext records created
before a room was locked are retained for backward compatibility and returned
with `legacy_plaintext: true`. BB84 and post-processing results are ephemeral
and are not returned by this endpoint.

## Local network status

`GET /api/network`

Returns the LAN invitation configuration:

```json
{
  "mode": "lan",
  "advertised_host": "192.168.1.42",
  "port": 8080,
  "ready": true
}
```

Without `LAN_ADVERTISE_IP`, the endpoint returns localhost mode, a null host
and `ready: false`. Configuration accepts RFC1918 IPv4 addresses only.

## Real-time connection

`WS /ws/{room_id}?client_id={id}&display_name={name}`

Room and client IDs contain 1 to 64 letters, numbers, underscores or hyphens.
Display names contain 1 to 50 visible characters. A room accepts two distinct
live client IDs.

## Legacy plaintext chat events

Client events:

```json
{"type":"message","text":"Hello","client_message_id":"local-123"}
```

```json
{"type":"typing","is_typing":true}
```

```json
{"type":"ping"}
```

Legacy plaintext messages remain available only until the first accepted
Phase 4 key advertisement durably locks that room. Afterward, `message` is
rejected with `e2ee_required`, including after a server restart. This prevents
a reconnect or restart from silently downgrading an encrypted room.

Acknowledgement means the creator authority accepted and persisted a record;
it is not proof that the other participant read or decrypted it.

## Browser-to-browser encrypted chat

The private ECDH keys and derived AES keys remain inside the two browsers. The
backend validates public metadata, relays current public keys, and stores only
the opaque AES-GCM envelope. It never receives plaintext or private/derived key
material for a Phase 4 message.

On connection, the server returns the normal `connected` fields plus:

```json
{
  "e2ee_required": true,
  "e2ee_public_keys": [
    {
      "client_id": "alice",
      "display_name": "Alice",
      "version": "e2ee-v1",
      "algorithm": "ECDH-P256",
      "public_key_id": "3xqkbcC7DMgkDedhKUTsP_qdB6WY5n58L69gA3-CBtE",
      "public_key": "BAfw4JAvNFqMGJA31Y7nbxq5LVOcaSTeWIYyIaw7RCRBWZjLh2rMXiedLTdoH7Hoe8CGqxMmZzd-hlyJY1v1h4A"
    }
  ]
}
```

Only keys for currently connected peers are cached. Private keys never reach
the server, and public-key advertisements are not stored in SQLite.

Each browser advertises an ephemeral or device-local P-256 public key:

```json
{
  "type": "e2ee_hello",
  "version": "e2ee-v1",
  "algorithm": "ECDH-P256",
  "public_key_id": "3xqkbcC7DMgkDedhKUTsP_qdB6WY5n58L69gA3-CBtE",
  "public_key": "BAfw4JAvNFqMGJA31Y7nbxq5LVOcaSTeWIYyIaw7RCRBWZjLh2rMXiedLTdoH7Hoe8CGqxMmZzd-hlyJY1v1h4A"
}
```

`public_key` is a canonical, unpadded base64url encoding of a 65-byte
uncompressed P-256 key. `public_key_id` is the canonical 43-character
base64url SHA-256 digest of those raw bytes. The server broadcasts an accepted
advertisement as `e2ee_public_key`, adding the current WebSocket connection's
self-asserted `client_id` and `display_name`. It rejects two active clients
advertising the same public-key ID.

Once both current clients have advertised keys, either browser may send:

```json
{
  "type": "encrypted_message",
  "client_message_id": "local-124",
  "version": "e2ee-v1",
  "algorithm": "AES-256-GCM",
  "key_id": "XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU",
  "iv": "MDEyMzQ1Njc4OWFi",
  "ciphertext": "b3BhcXVlLWNpcGhlcnRleHQ"
}
```

The IV must decode to exactly 12 bytes. Ciphertext is canonical unpadded
base64url, includes the 16-byte GCM tag, and decodes to 17 through 4,112 bytes,
representing 1 through 4,096 plaintext UTF-8 bytes. The complete JSON event
therefore remains below the default 8,192-byte inbound WebSocket-frame limit.
Reusing an IV with the same room, pair-key ID and sender-key ID is rejected as
`e2ee_iv_reuse`.

The server computes `key_id` as SHA-256 over these exact bytes:

1. ASCII `QKD-CHAT-E2EE-PAIR-KEY-ID-v1` followed by a zero byte
2. room ID UTF-8 byte length as an unsigned 16-bit big-endian integer
3. room ID UTF-8 bytes
4. the two decoded 65-byte public keys in unsigned bytewise lexicographic order

The result is encoded as canonical unpadded base64url. Sorting encoded strings
or using locale-aware comparison is not equivalent. For the two public keys
shown in the backend test vector and room `demo`, the result is
`XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU`.

The server injects `sender_key_id` from the sending connection's registered
advertisement; clients must not supply it. The broadcast shape is:

```json
{
  "type": "encrypted_message",
  "message": {
    "id": "4",
    "client_message_id": "local-124",
    "sender_id": "alice",
    "sender_name": "Alice",
    "sent_at": "2026-09-14T12:30:00.000Z",
    "kind": "encrypted_message",
    "version": "e2ee-v1",
    "algorithm": "AES-256-GCM",
    "key_id": "XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU",
    "sender_key_id": "3xqkbcC7DMgkDedhKUTsP_qdB6WY5n58L69gA3-CBtE",
    "iv": "MDEyMzQ1Njc4OWFi",
    "ciphertext": "b3BhcXVlLWNpcGhlcnRleHQ"
  }
}
```

There is deliberately no `text` field. Duplicate retries with the same
sender/client-message ID and identical immutable envelope receive the normal
`message_ack` with `duplicate: true` and are not broadcast again. Reusing the
same ID for changed envelope content returns `message_id_conflict`.

The current browser implementation derives two directional AES-256-GCM keys
from P-256 ECDH with HKDF-SHA-256. It uses the decoded pair transcript hash as
the HKDF salt and the UTF-8 info values
`e2ee-v1/AES-256-GCM/low-to-high` and
`e2ee-v1/AES-256-GCM/high-to-low`. AES-GCM additional authenticated data is
the newline-joined UTF-8 sequence of version, room ID, sender client ID,
sender display name, client-message ID, sender-key ID and pair-key ID. A
metadata substitution therefore causes browser decryption to fail.

This exchange does not authenticate a person's identity or stop an active
key-substitution attack by a malicious relay. The displayed safety code must
be compared through an independent trusted channel before users treat the
session as verified. The application makes no automatic identity claim.

## Start a shared BB84 simulation

Either connected participant may send:

```json
{
  "type": "bb84_start",
  "qubit_count": 1024,
  "noise_probability": 0.0,
  "intercept_probability": 0.0,
  "sample_ratio": 0.1,
  "qber_threshold": 0.11,
  "seed": 1
}
```

All configuration fields except `type` are optional. Defaults are 512 qubits,
zero noise and interception, a 0.25 sample ratio, a 0.11 QBER threshold and a
null seed. Validation bounds are:

- `qubit_count`: 128, 256, 512 or 1024;
- `noise_probability`: 0 to 0.25;
- `intercept_probability`: 0 to 1;
- `sample_ratio`: 0.1 to 0.5;
- `qber_threshold`: 0.01 to 0.25;
- `seed`: null or a JSON-safe integer from 0 to 2^53 - 1
  (`9007199254740991`).

The seed is returned in `bb84_result.config`. A non-null seed makes the model
deterministic: anyone with the public seed, settings, room/session context and
implementation can reconstruct the simulated transcript and derived values.
Seeded runs provide repeatability for teaching, not secrecy.

An invalid command returns the existing `validation_error` event. Extra fields
are rejected. Only one experiment may run in a room at a time; a competing
request receives the recoverable `bb84_busy` error.

## Shared BB84 result

The creator room authority broadcasts one result to both active participants:

```json
{
  "type": "bb84_result",
  "session_id": "sim_42e1d6c89fd18a2b77ed6a31",
  "started_by": "alice-client-id",
  "created_at": "2026-09-13T12:30:00.000Z",
  "simulation_only": true,
  "chat_encryption_active": false,
  "config": {
    "qubit_count": 1024,
    "noise_probability": 0.0,
    "intercept_probability": 0.0,
    "sample_ratio": 0.1,
    "qber_threshold": 0.11,
    "seed": 1
  },
  "metrics": {
    "transmitted": 1024,
    "intercepted": 0,
    "sifted": 531,
    "sample": 54,
    "mismatches": 0,
    "qber": 0.0,
    "retained": 477
  },
  "decision": {
    "status": "accepted",
    "reason": "qber_within_threshold"
  },
  "post_processing": {
    "version": "phase3-post-processing-v1",
    "status": "completed",
    "reason": "completed",
    "input_bits": 477,
    "reconciliation": {
      "algorithm": "cascade-inspired-parity-v1",
      "passes": 1,
      "corrected_errors": 0,
      "remaining_errors": 0,
      "leaked_bits": 8,
      "verified": true
    },
    "privacy_amplification": {
      "algorithm": "toeplitz-universal-hash-v1",
      "entropy_model": "illustrative-asymptotic-bb84-binary-entropy-v1",
      "security_margin_bits": 32,
      "estimated_secret_bits": 437,
      "output_bits": 128
    },
    "confirmation": {
      "algorithm": "hmac-sha256-truncated-v1",
      "tag_bits": 128,
      "passed": true
    },
    "derivation": {
      "algorithm": "hkdf-sha256-v1",
      "output_bits": 256,
      "context_bound": true,
      "material_retained": false
    },
    "key_material_exposed": false,
    "key_used_for_chat": false,
    "reproducible_teaching_run": true
  },
  "trace": [
    {
      "index": 0,
      "alice_basis": "X",
      "bob_basis": "Z",
      "basis_match": false,
      "intercepted": false,
      "sampled": false,
      "sample_comparison": null
    }
  ]
}
```

`metrics.qber` is null only if there is no disclosed sample. Decision status is
`accepted` or `aborted`; reasons are `qber_within_threshold`,
`qber_above_threshold` or `insufficient_sifted_bits`. The representative trace
contains at most 24 rows, combining disclosed sample rows with undisclosed
context rows. `sample_comparison` is `match` or `mismatch` only for disclosed
rows and otherwise null. The `intercepted` flag is simulator ground truth, not
something Alice and Bob could observe in a physical exchange. No raw bit
sequence or key material is sent.

`simulation_only` is always true and `chat_encryption_active` is always false.
The BB84 decision describes only the disclosed QBER sample. An accepted result
then enters Phase 3 post-processing; it does not by itself indicate that
post-processing completed.

## Phase 3 post-processing report

Every `bb84_result` contains one `post_processing` object. Its valid status and
reason combinations are:

| Status | Reason | Meaning |
| --- | --- | --- |
| `completed` | `completed` | All four modeled stages completed and the internal demonstration output was discarded. |
| `skipped` | `bb84_not_accepted` | BB84 was aborted, so no post-processing stage ran. |
| `failed` | `reconciliation_failed` | Bounded parity passes left differences between the simulated candidates. |
| `failed` | `insufficient_entropy` | The illustrative estimate was below the required 128 bits. |
| `failed` | `confirmation_failed` | Defensive fault path: the independently calculated internal confirmation values did not agree. |
| `failed` | `derivation_failed` | Defensive fault path: the post-confirmation derived values did not agree. |

The last two reasons are internal-consistency guards, not expected channel
outcomes. After successful reconciliation, equal inputs processed by the same
deterministic confirmation and derivation code should agree. They exist so an
unexpected implementation or runtime fault fails closed and can be represented
without exposing material.

For `confirmation_failed`, reconciliation is verified, the 128-bit privacy
output was produced, `confirmation.passed` is false, and derivation reports
zero output with `context_bound: false`. For `derivation_failed`, the same
reconciliation and privacy preconditions hold, `confirmation.passed` is true,
and derivation reports zero output with `context_bound: false`. Both keep
`material_retained`, `key_material_exposed` and `key_used_for_chat` false.

The nested fields mean:

- `input_bits` equals `metrics.retained`.
- `reconciliation` reports the algorithm, executed pass count, corrected and
  remaining simulator-ground-truth errors, disclosed parity-bit leakage and
  whether both internal sequences matched.
- `privacy_amplification` names the Toeplitz universal hash and the explicitly
  illustrative entropy model. The current estimate is
  `floor(n × (1 - h2(min(Q, 0.5))) - leaked_bits - 32)`, clamped from zero
  through `n`, where `n` is `input_bits`, `Q` is sampled QBER and `h2` is
  binary entropy.
  This is an educational asymptotic calculation, not a finite-key security
  proof. `output_bits` is 128 only when the estimate permits processing to
  continue; otherwise it is zero.
- `confirmation` reports a 128-bit truncated HMAC-SHA-256 comparison result.
  Tags themselves are never returned.
- `derivation` reports a 256-bit HKDF-SHA-256 output on completion, bound to the
  protocol version, room ID and unique session ID. Its `output_bits` is zero
  when derivation was not completed. HKDF formats and separates the 128-bit
  privacy-amplified input; its longer output does not create additional
  entropy. `material_retained` is always false.
- `reproducible_teaching_run` is true when the optional deterministic teaching
  seed was supplied. Because the seed, settings and room/session context are
  shared, such a run is reconstructible and its simulated key material is not
  secret.

The server builds this report from an explicit allow-list. It never sends
candidate or reconciled bits, Toeplitz seed material, privacy-amplified values,
confirmation tags, HKDF salt or derived bytes. `key_material_exposed` is always
false because no key bytes are serialized in this report; it is not a claim
that the deterministic seeded run or wider system provides secrecy.
`key_used_for_chat` is always false.

## LAN relay behaviour

For a LAN invitation, the joining backend transparently relays the same event
contract to the creator backend. This includes `e2ee_hello`,
`e2ee_public_key`, encrypted envelopes and acknowledgements. Ciphertext is
created and opened only in the browsers; the guest and creator backends see
the same opaque envelope. A guest `bb84_start` runs once at the creator and
the resulting `bb84_result` returns to both participants. BB84 results,
including `post_processing`, are not persisted or included in a later
`connected` event.

Each person must load the UI from that Mac's own `http://localhost` address.
Browsers treat localhost as a potentially trustworthy context for Web Crypto.
Loading the creator
UI directly over plain LAN HTTP is not a supported encrypted-UI path.

Client-to-creator commands retain the configured 8,192-byte default cap. The
relay separately allows creator-to-client frames up to 512 KiB because one
bounded `connected` frame can contain 50 history records. With maximum Phase 4
envelopes that response is approximately 303 KiB; a larger peer frame is
rejected as `event_too_large`.

`peer_unreachable` closes with code `4410` when the creator cannot be reached,
a relay loop is detected, or the peer handshake fails. Other important error
codes include `invalid_identity`, `invalid_room_code`, `room_full`,
`invalid_json`, `validation_error`, `message_too_long`, `event_too_large`,
`unsupported_event`, `origin_not_allowed`, `e2ee_required`, `e2ee_not_ready`,
`e2ee_key_mismatch`, `e2ee_public_key_conflict`, `e2ee_iv_reuse` and
`message_id_conflict`.

## Current security boundary

Phase 4 chat uses browser-held P-256 ECDH material and AES-256-GCM envelopes.
The backend stores ciphertext, IV and public routing metadata only. The
durable room lock prevents plaintext fallback, and the server rejects an IV
already seen in the same directional-key namespace. TLS, authenticated public
keys, account identities, multi-device key distribution and delivery/read
receipts remain outside this slice.

BB84 and both simulated post-processing roles still run inside the trusted
creator backend. Their `chat_encryption_active: false` and
`key_used_for_chat: false` fields refer only to the simulated BB84-derived
material. The independent Web Crypto E2EE channel does not consume or depend
on the BB84 simulation result.
