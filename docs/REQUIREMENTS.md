# Archived Phase 3 First Slice Requirements

> **Archived, not current product behavior:** this file records the requirements
> against which the previous plaintext chat and post-processing slice was
> accepted. The current Phase 4 build encrypts chat in the browsers. Its
> requirements and security boundaries are documented in
> [PHASE_STATUS.md](PHASE_STATUS.md) and
> [PHASE4_E2EE_THREAT_MODEL.md](PHASE4_E2EE_THREAT_MODEL.md).

These requirements cover educational key post-processing after the shared
BB84 and QBER experiment. Phase 3 builds on the existing two-person chat,
dual-Mac relay and Phase 2 simulator. It does not add encrypted chat.

## Existing behavior that must remain

- Two participants can create or join a local or dual-Mac LAN room.
- Plaintext messages, acknowledgements, presence and typing continue to work.
- Plaintext message history remains in SQLite.
- Either participant can start one bounded, shared BB84 experiment.
- The creator room authority broadcasts one identical result to both clients.
- QBER-aborted experiments never proceed into key post-processing.
- The public trace remains bounded and contains no raw bit values.

## Private simulation material

- The BB84 domain result may retain Alice's and Bob's undisclosed candidate
  bits only in private process memory.
- Private bits must not appear in JSON, logs, exceptions, SQLite, history,
  browser state or the public result dataclass.
- Public serialization must use an explicit allow-list rather than a generic
  dataclass or object dump.
- Private material and any derived bytes are discarded after the report is
  produced. Python cannot guarantee physical memory zeroization, so this is a
  lifecycle boundary rather than a hardware erasure claim.

## Post-processing requirements

- Post-processing starts only when the BB84 sample decision is accepted.
- A bounded, Cascade-inspired parity reconciliation model corrects Bob's
  retained candidate bits over multiple passes.
- Every announced parity comparison is counted as reconciliation leakage.
- The report records corrected and remaining error counts. These are simulator
  ground truth and would not be directly visible in a physical deployment.
- Privacy amplification uses a Toeplitz universal hash, not HKDF relabelled as
  privacy amplification.
- The usable-bit estimate is
  `floor(n × (1 - h2(min(Q, 0.5))) - reconciliation leakage - 32)`, clamped
  from zero through `n`, where `n` is the retained input count and `Q` is
  sampled QBER. The disclosed sample is already excluded from `n` and is not
  subtracted again.
- The modeled 128-bit confirmation tags remain internal and are not counted as
  public leakage because they are never broadcast in this slice.
- The estimate is clearly labelled as an illustrative asymptotic binary
  entropy model. It is not a finite-key security proof.
- A BB84-accepted run with too little estimated entropy returns a separate
  `insufficient_entropy` outcome and does not derive a key.
- Key confirmation uses independently calculated, truncated HMAC-SHA-256 tags
  and a constant-time comparison.
- A final HKDF-SHA-256 derivation is bound to the protocol version, room ID and
  unique simulation session ID.
- Toeplitz privacy amplification produces 128 bits only when the estimate is at
  least 128 bits; otherwise post-processing fails with
  `insufficient_entropy`.
- The KDF may produce a 256-bit demonstration output from that 128-bit input,
  but this expansion does not create entropy. The report must not claim more
  than 128 bits of strength or more than the estimated input entropy.
- Seeded runs remain reproducible teaching runs. Their deterministic random
  source is never described as cryptographically secure. Because the public
  result includes the seed and settings, a seeded transcript and its derived
  values are reconstructible by anyone with the shared room/session context and
  must be treated as non-secret.
- `confirmation_failed` and `derivation_failed` are defensive internal fault
  paths. They are not presented as normal outcomes after equal reconciled
  inputs enter the same deterministic implementation.

## Public result requirements

- `bb84_result` includes a strict, secret-free `post_processing` object.
- The object reports status, reason, input count, reconciliation metrics,
  privacy-amplification metrics, confirmation status and derivation metadata.
- It explicitly states that no key bytes were serialized in the report, no
  derived material was retained and no key was used for chat.
- QBER-aborted runs report post-processing as skipped.
- Insufficient entropy, reconciliation failure and defensive confirmation or
  derivation faults are shown as post-processing failures without terminating
  the room connection.
- `simulation_only` remains `true`.
- `chat_encryption_active` and `key_used_for_chat` remain `false`.
- Neither the BB84 candidate bits, Toeplitz seed, confirmation tags, HKDF salt
  nor derived bytes may be sent to a browser.
- `key_material_exposed: false` means that those bytes were not serialized. It
  must not be used as a secrecy claim, especially for a reconstructible seeded
  run.

## Interface requirements

- The product badge identifies the build as Phase 3 key post-processing.
- The Protocol Lab shows a second four-stage path:
  Reconcile, Reduce exposure, Confirm and Derive.
- Completed, skipped and failed outcomes are understandable without relying on
  color alone.
- Leakage, estimated usable bits and output length are explained in plain
  language.
- An insufficient-entropy result explains that a KDF cannot create missing
  entropy and recommends a larger or cleaner experiment.
- Persistent text states that processing occurs inside the trusted creator
  backend, all chat remains plaintext, and the result is not end-to-end
  encryption or physical QKD.
- Existing focus, keyboard, mobile and reduced-motion behavior remains intact.

## Explicitly out of scope

- AES-256-GCM chat envelopes, nonce sequencing and replay protection;
- browser-to-browser key ownership or recovery after refresh;
- an authenticated classical discussion channel;
- authenticated accounts or verified participant identities;
- HTTPS, WSS or production TLS termination;
- physical photon transmission or quantum hardware;
- a composable or experimentally certified finite-key proof.

## Acceptance criteria

- Pure tests cover reconciliation success and failure, exact leakage counting,
  Toeplitz hashing, entropy outcomes, HMAC tamper rejection and context-bound
  HKDF derivation.
- Recursive output tests prove that raw bits, tags, salts and derived key bytes
  are absent from the public payload.
- WebSocket tests verify identical Phase 3 reports for both participants,
  skipped post-processing after QBER abort and continued plaintext chat.
- Database checks prove that post-processing material is not persisted.
- Frontend tests cover completed, skipped, insufficient-entropy,
  reconciliation-failed, confirmation-failed and derivation-failed displays,
  strict parsing, safety language and accessibility.
- Existing backend, frontend, Docker, deployed smoke and dual-host relay tests
  remain green.
