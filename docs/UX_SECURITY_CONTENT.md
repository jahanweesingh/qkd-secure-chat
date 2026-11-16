# Archived Phase 3 Security Status UX and Content Specification

> **Archived, not current product behavior:** every plaintext status below
> documents the completed Phase 3 interface. The current Phase 4 build encrypts
> chat in the browsers, and its required language supersedes this file:
> [PHASE4_SECURITY_UX.md](PHASE4_SECURITY_UX.md). The Protocol Lab boundary
> remains valid: its simulated values never supply or verify Phase 4 chat keys.

## Purpose

The interface must let a student understand two facts immediately:

1. The chat works, but its messages are plaintext.
2. The Protocol Lab is a software simulation. Completing it does not encrypt
   the chat.

The technical detail can be revealed progressively. The current protection
state must never be hidden behind a tooltip, modal or technical label.

## One mental model

Treat chat and the Protocol Lab as two parallel parts of the product:

| Part | Current state | Effect on chat protection |
| --- | --- | --- |
| Message transport | HTTP and WebSocket, plaintext | None |
| Message storage | SQLite, plaintext | None |
| BB84 | Classical software simulation | None |
| Reconciliation | Modeled on the trusted room host | None |
| Privacy amplification | Modeled with a Toeplitz hash | None |
| Confirmation | Internal HMAC consistency check | None |
| Derivation | Internal HKDF output, then discarded | None |
| AES-256-GCM | Planned, not active | None in Phase 3 |

The UI should never place a green protocol result next to chat in a way that
looks like a security upgrade. Connection status and encryption status are
different states.

## Information hierarchy

### 1. Persistent chat status

Show this in the conversation header at all viewport sizes:

- visible label: **Chat: Plaintext**
- accessible label: **Chat encryption is off. Messages are sent and stored as
  plaintext.**

Keep the connection indicator separate:

- **Connection: Live** means WebSocket delivery is working.
- **Chat: Plaintext** means message encryption is not active.

The phase badge remains secondary:

- desktop: **Phase 3 · protocol simulation**
- compact visible label: **P3 · simulation**
- accessible label: **Phase 3 protocol simulation. Chat remains plaintext.**

Do not combine “Live” and “secure” language. A live connection is not an
encrypted connection.

### 2. Onboarding disclosure

Place one short status block beside the create or join action. Recommended
copy:

> **Current protection: plaintext**  
> Messages are not encrypted by this app. Use it only on a trusted local
> network and do not share confidential information.

Use direct product language above it:

- heading: **Two-person chat with a BB84 teaching lab**
- supporting line: **Chat in real time, then explore a shared software
  simulation of BB84 and post-processing.**

The capability list should say **Plaintext local message history**, not only
“durable local message history.”

### 3. Room details

Use a small state summary instead of another long warning:

| Label | Value |
| --- | --- |
| Chat messages | Plaintext |
| BB84 | Software simulation |
| Post-processing | Modeled on room host |
| Temporary material | Discarded |
| AES-GCM | Planned, not active |

Follow it with one sentence:

> Protocol results never activate or change chat encryption.

### 4. Protocol Lab boundary

At the top of the dialog, before the controls, show:

> **Simulation only · chat stays plaintext**  
> The room host models BB84, reconciliation, privacy amplification,
> confirmation and derivation. This is not physical QKD or end-to-end
> encryption.

Recommended action label: **Run teaching experiment**.

Recommended running state:

- title: **Running the software model**
- detail: **The room host is simulating BB84. Post-processing runs only if the
  disclosed sample passes.**

### 5. Separate the two decisions

The result has two independent outcomes. Present them in this order:

1. **BB84 sample decision**
2. **Post-processing model outcome**

Use **Sample accepted** or **Sample rejected**, not a standalone “Accepted” or
“Aborted.” Acceptance means only that sampled QBER is within the selected
limit and retained positions exist.

Use **Post-processing model completed**, not wording that can be read as “a
secure key was established.” Directly below every outcome show:

> **Chat encryption: Off**  
> This result does not change message transport or storage.

### 6. Stage language

Keep the four current stage-rail names and use one plain sentence for each:

- **Reconcile:** Attempt to correct simulated disagreements and count each
  disclosed parity bit.
- **Reduce exposure:** Apply the illustrative entropy estimate, subtract the
  margin and model 128-bit Toeplitz compression.
- **Confirm:** Compare internal HMAC tags. This checks the simulation, not the
  participants' identities.
- **Derive:** Format the 128-bit input as a 256-bit-sized HKDF
  output, bind it to the run context and discard it. HKDF adds no entropy.

The detailed card may use **Derive and discard** as its title because it makes
the lifecycle explicit without changing the shorter stage-rail label.

Use the visible states **Completed**, **Stopped here** and **Not run**. Do not
use color alone to communicate them.

### 7. Outcome copy

Use these exact headings and short explanations:

| Reason | Heading | Explanation |
| --- | --- | --- |
| `completed` | Post-processing model completed | All four teaching stages ran. Temporary output was discarded and chat remains plaintext. |
| `bb84_not_accepted` | Post-processing was not started | The BB84 sample did not pass, so later stages did not run. |
| `reconciliation_failed` | Reconciliation could not be verified | Differences remained after the bounded teaching passes, so processing stopped. |
| `insufficient_entropy` | Not enough estimated secret information | The illustrative estimate was below 128 bits. Try a larger or cleaner run. HKDF cannot create missing entropy. |
| `confirmation_failed` | Internal confirmation check failed | A defensive consistency check did not match. Temporary material was discarded. |
| `derivation_failed` | Internal derivation check failed | Confirmation passed, but the derived values did not match. Temporary material was discarded. |

The last two are defensive software-fault paths. Do not describe them as
normal channel or QBER outcomes.

### 8. Result guardrails

Use this heading:

> **No key bytes are sent to the browser or used for chat**

Then show the three concrete fields:

- Serialized in report: No
- Used for chat: No
- Retained by processor: No

Do not shorten `key_material_exposed: false` to “the key is secret.” It means
only that key bytes were not serialized in the result.

For seeded runs, show:

> **Predictable teaching run**  
> The shared seed, settings, room and session context make this run
> reconstructible. It provides no secrecy or cryptographic randomness.

For unseeded runs, show:

> **Unseeded software run**  
> This remains a trusted-server simulation, not physical QKD or an end-to-end
> key exchange.

### 9. Planned encryption

Put roadmap content in a secondary “Planned, not active” area. Recommended
copy:

> **AES-256-GCM is planned for a later phase.** It is not active in this build.
> A future encryption phase must also define key ownership, authenticated
> identities, nonce uniqueness, replay handling, ciphertext storage and TLS.

Do not promise end-to-end encryption merely because AES-GCM is planned. That
claim depends on where keys live and which systems can access plaintext.

## Terminology rules

### Use

- plaintext chat
- software simulation
- teaching model
- sampled QBER
- sample accepted or sample rejected
- modeled post-processing
- internal consistency check
- temporary output discarded
- AES-GCM planned, not active

### Avoid

- secure room
- quantum-secure chat
- encrypted conversation
- key established
- protected by BB84
- eavesdropper detected
- safe to share
- encryption successful

QBER can be raised by modeled noise or interception. It does not prove that an
eavesdropper was present.

## Accessibility and announcement behavior

- Keep **Chat: Plaintext** visible and readable without relying on color.
- Give compact badges full accessible labels. Do not expose an unexplained
  “P3” abbreviation to assistive technology.
- Announce only the new sample decision and post-processing outcome. Do not
  make the full metric region live.
- Include “chat encryption remains off” in the completion announcement.
- Keep explanations available through keyboard-accessible disclosure controls.
- Use the same status words on desktop and mobile.

## Content priority

When space is limited, preserve copy in this order:

1. **Chat: Plaintext**
2. **Simulation only**
3. **Result does not change chat encryption**
4. **AES-GCM planned, not active**
5. Detailed algorithm and metric explanations

This order prevents technical success states from hiding the product's actual
security state.
