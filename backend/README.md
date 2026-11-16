# QKD Chat Lab Backend

FastAPI and SQLite service for a persistent two-user chat, Phase 4 opaque E2EE
envelope relay and the separate classical BB84/post-processing teaching
simulation. Browsers perform P-256 ECDH, HKDF-SHA-256 and AES-256-GCM. This
service validates current public-key advertisements, enforces the immutable
`e2ee_required` room lock, relays encrypted envelopes and stores ciphertext
plus clear routing metadata. It never performs browser ECDH/AES operations or
receives encrypted-message plaintext.

After an accepted QBER sample, the trusted creator backend still models
bounded reconciliation, parity leakage, illustrative entropy accounting,
Toeplitz privacy amplification, HMAC confirmation and context-bound HKDF
derivation. That demonstration material is discarded and never used as a chat
key.

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload
```

The API is available at `http://127.0.0.1:8000`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/chat.db` | SQLite file |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5173` | Comma-separated browser origins |
| `MAX_MESSAGE_LENGTH` | `2000` | Legacy plaintext character cap; encrypted envelopes have a fixed 4,096-byte plaintext limit |
| `HISTORY_LIMIT` | `100` | Maximum messages returned or sent at connection |
| `MAX_WEBSOCKET_EVENT_BYTES` | `8192` | Maximum encoded client event size |
| `LAN_ADVERTISE_IP` | unset | RFC1918 address advertised for a same-LAN invitation |
| `APP_PORT` | `8080` | Browser-facing port included in LAN invitation metadata |

Set `HOST` and `PORT` in Docker Compose and pass them to the Uvicorn command when a deployment needs values other than `0.0.0.0:8000`.

## Fixed contract

- `GET /api/health`
- `GET /api/network`
- `GET /api/rooms/{room_id}/messages?limit=50`
- `WS /ws/{room_id}?client_id=alice&display_name=Alice`

Client events:

```json
{"type":"message","text":"Hello","client_message_id":"local-1"}
{"type":"e2ee_hello","version":"e2ee-v1","algorithm":"ECDH-P256","public_key_id":"3xqkbcC7DMgkDedhKUTsP_qdB6WY5n58L69gA3-CBtE","public_key":"BAfw4JAvNFqMGJA31Y7nbxq5LVOcaSTeWIYyIaw7RCRBWZjLh2rMXiedLTdoH7Hoe8CGqxMmZzd-hlyJY1v1h4A"}
{"type":"encrypted_message","client_message_id":"local-2","version":"e2ee-v1","algorithm":"AES-256-GCM","key_id":"XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU","iv":"MDEyMzQ1Njc4OWFi","ciphertext":"b3BhcXVlLWNpcGhlcnRleHQ"}
{"type":"typing","is_typing":true}
{"type":"ping"}
{"type":"bb84_start","qubit_count":512,"noise_probability":0.0,"intercept_probability":0.0,"sample_ratio":0.25,"qber_threshold":0.11,"seed":1984}
```

Server events:

```json
{"type":"connected","client_id":"alice","room_id":"demo","participants":[],"messages":[],"e2ee_required":false,"e2ee_public_keys":[]}
{"type":"presence","action":"joined","client_id":"alice","display_name":"Alice","participants":[]}
{"type":"message","message":{"id":"1","client_message_id":"local-1","sender_id":"alice","sender_name":"Alice","text":"Hello","sent_at":"2026-09-08T00:00:00.000Z","kind":"message"}}
{"type":"e2ee_public_key","client_id":"alice","display_name":"Alice","version":"e2ee-v1","algorithm":"ECDH-P256","public_key_id":"3xqkbcC7DMgkDedhKUTsP_qdB6WY5n58L69gA3-CBtE","public_key":"BAfw4JAvNFqMGJA31Y7nbxq5LVOcaSTeWIYyIaw7RCRBWZjLh2rMXiedLTdoH7Hoe8CGqxMmZzd-hlyJY1v1h4A"}
{"type":"encrypted_message","message":{"id":"2","client_message_id":"local-2","sender_id":"alice","sender_name":"Alice","sent_at":"2026-09-14T00:00:00.000Z","kind":"encrypted_message","version":"e2ee-v1","algorithm":"AES-256-GCM","key_id":"XeLV5yWO5aVxNicXWe3nwZRRy5stqz7eI6d-zcM9wTU","sender_key_id":"3xqkbcC7DMgkDedhKUTsP_qdB6WY5n58L69gA3-CBtE","iv":"MDEyMzQ1Njc4OWFi","ciphertext":"b3BhcXVlLWNpcGhlcnRleHQ"}}
{"type":"message_ack","client_message_id":"local-1","message_id":"1","sent_at":"2026-09-08T00:00:00.000Z","duplicate":false}
{"type":"typing","client_id":"alice","display_name":"Alice","is_typing":true}
{"type":"pong"}
{"type":"error","code":"validation_error","message":"Event payload is invalid","client_message_id":"local-1"}
```

`bb84_result` is also a server event. Its nested fields are intentionally not
abbreviated as empty JSON objects here because that would not be a valid
payload. See `../docs/API.md` for the complete, parser-valid example.

The plaintext `message` event is retained only for an unlocked legacy room.
The first accepted `e2ee_hello` durably activates `e2ee_required`; after that,
plaintext insertion is rejected. The encrypted message command never accepts
`sender_key_id`; the backend injects it from the sender's active hello. See
`../docs/API.md` for canonical base64url rules, the pair-key calculation,
4,096-byte plaintext/4,112-byte ciphertext bounds and the complete error
contract.

The creator room authority runs each `bb84_start` once and broadcasts the same
ephemeral `bb84_result` to both active participants, including across the LAN
relay. QBER-aborted runs report post-processing as `skipped`; accepted runs may
be `completed` or may fail separately because reconciliation could not be
verified or the illustrative entropy estimate was too small. Confirmation and
derivation failures (`confirmation_failed` and `derivation_failed`) are
defensive internal-consistency fault paths, not normal outcomes of equal
verified inputs. The public event exposes aggregate and bounded
teaching diagnostics only. It never includes candidate or reconciled bits,
Toeplitz seed material, privacy-amplified values, HMAC tags, HKDF salt or
derived bytes. See `../docs/API.md` for the complete schema and parameter
bounds.

The post-processing report always keeps `key_material_exposed` and
`key_used_for_chat` false. `simulation_only` remains true and
`chat_encryption_active` remains false. Toeplitz hashing produces a 128-bit
privacy-amplified value before HKDF formats a 256-bit internal demonstration
output. That expansion does not create entropy: the modeled strength cannot
exceed the 128-bit input or the lower illustrative entropy estimate.

`key_material_exposed: false` means that key bytes were not serialized in the
report; it is not a secrecy guarantee. A teaching seed is public in the result,
and the simulation is deterministic. Anyone with the seed, settings,
room/session context and source can reconstruct a seeded run, so its candidate
and derived values are not secret.

Messages are acknowledged before their broadcast. Retrying the same
`client_message_id` for the same sender and room returns the existing
acknowledgement only when the immutable payload matches; changed content
returns `message_id_conflict`. AES-GCM IV reuse is durably rejected within the
directional `(room_id, key_id, sender_key_id)` namespace. Errors include
`client_message_id` when available so the UI can reconcile a failed optimistic
item. A room accepts at most two distinct active `client_id` values.

## Docker

```bash
docker build -t secure-chat-starter .
docker run --rm -p 8000:8000 -v secure-chat-data:/data secure-chat-starter

# Run tests using Docker only
docker build --target test -t secure-chat-starter-test .
docker run --rm secure-chat-starter-test
```

The production image is the final `production` stage and runs as non-root user 10001. The named `test` stage contains the development dependencies and test suite.

Use a TLS reverse proxy so browsers connect through HTTPS and WSS outside local
development. Both classroom Macs open their own `http://localhost:8080` secure
context; a browser loaded directly from another Mac's plain LAN HTTP address is
unsupported. Browser WebSocket origins are checked against `ALLOWED_ORIGINS`;
non-browser clients may omit `Origin`. Client identifiers and public keys are
self-asserted. Until users compare the complete locally derived safety code,
an active relay can substitute keys. The static P-256 design has no Noise
handshake, Double Ratchet, forward secrecy or post-compromise security. The
Phase 3 processor runs both simulated roles inside this backend, so its
confirmation result never authenticates the two people or changes Phase 4 chat
keys.

`GET /api/network` reports whether the instance has peer-reachable LAN invitation metadata. Without `LAN_ADVERTISE_IP`, it returns localhost mode with `ready: false`. When configured with an address from `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`, it returns LAN mode, the address, `APP_PORT`, and `ready: true`. Translation-only CLAT addresses such as `192.0.0.2`, public addresses, loopback, link-local, and IPv6 literals are rejected. The endpoint reports connection metadata only; it neither publishes the application to the internet nor synchronizes separate databases.

### Same-LAN invitation relay

LAN invitation room IDs use this strict format:

```text
QKD-<16 Crockford Base32 characters>-<7 Crockford Base32 characters>
```

The alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. The last seven characters encode the creator's unsigned 32-bit IPv4 value in network byte order, most-significant digit first. For example, `QKD-0123456789ABCDEF-30AG09A` identifies creator address `192.168.1.42`.

When that address matches this instance's `LAN_ADVERTISE_IP`, the WebSocket follows the normal local chat path. Otherwise, this backend opens a bounded, single-hop connection to `ws://<creator>:<APP_PORT>/ws/<room>` and transparently relays the existing message, presence, typing, acknowledgement, and history events. The creator remains the canonical backend and database. No new success event is introduced.

Relay targets are restricted to literal RFC1918 addresses and the configured `APP_PORT`. DNS names, public IPs, loopback, link-local, CLAT, arbitrary ports, compression, system proxies, and multi-hop relays are not allowed. A connection failure returns `peer_unreachable` and closes with code `4410`; an invitation containing an unsafe encoded address returns `invalid_room_code` and closes with `4400`.
