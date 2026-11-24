# Phase 4 Encryption Status and Verification UX

> **Simplified presentation:** the header contains one **Encryption demo**
> entry plus distinct encryption and connection badges. Routine explanations
> and mechanism steps are in disclosures; failure, changed-key and session-only
> warnings remain visible. The demo defaults to an isolated, visible-key
> learning exercise. **Live chat** shows actual ciphertext and backend ACK
> fields; production private/AES keys are never displayed. Details are in
> [SIMPLE_ENCRYPTION_DEMO.md](SIMPLE_ENCRYPTION_DEMO.md).

> **Encrypted media update (12 November 2026):** images and videos now use a
> fresh browser AES-GCM file key, opaque HTTP storage and a key-bearing descriptor
> protected by the existing chat envelope. See [ENCRYPTED_MEDIA.md](ENCRYPTED_MEDIA.md)
> for the capability gate, key lifecycle, quotas and limitations. Text key
> establishment and the independent BB84 simulation remain unchanged.

## Purpose

Phase 4 encrypts chat content in the two browsers. The interface must keep four
facts separate:

1. whether the LAN connection is live;
2. whether this browser has working message keys;
3. whether this user compared the current safety code; and
4. whether the local private key can survive a refresh.

The room-hosted Protocol Lab remains a separate teaching simulation. The BB84
Security Lab also exposes the endpoint-owned exchange; its output controls the
chat encryption label only after mutual confirmation activates the hybrid
epoch.

## BB84 Security Lab status and walkthrough

The lab reads the authoritative encryption mode from the chat hook and combines
it with endpoint protocol state. It distinguishes a completed experiment from
an active hybrid epoch, and reports ECDH fallback after switching back.
Connection remains a separate label. Only `encrypted_verified` may show local
safety-code verification.

BB84 status is not started, running, accepted, rejected, or result unavailable.
Here accepted means the complete post-processing pipeline finished. If the
sample passes but estimated secret material is too small, the overall result
is rejected/stopped and explains that distinction. An unavailable/timeout result
is not described as a measured rejection.

The seven review steps use actual aggregate results and redacted encoding
choices. Secret-bit positions are represented by locks, never real or invented
bit samples. A run stays pending until the one authoritative report arrives.
Subsequent progress is labeled **Review step**, not live simulation progress.
No stage is animated to imply photon transmission. Technical diagnostics and
advanced settings use keyboard-operable disclosures; focus skips their hidden
children and returns to the lab trigger on close.

## Persistent header hierarchy

Show connection and encryption as independent text statuses at every viewport:

| Status | Example |
| --- | --- |
| Connection | **Connection: Live** |
| Encryption | **Encrypted · Unverified** |

`Connection: Live` means only that WebSocket delivery is available. It must
not use a lock or the word secure. The encryption label is the primary safety
status and must not collapse into an icon on mobile.

## Visible encryption states

### Setting up

- label: **Encryption: Setting up**
- detail: **Exchanging browser public keys and preparing message keys. Sending
  is paused until both browsers are ready.**
- composer: disabled
- placeholder: **Waiting for encryption…**
- action after failure or timeout: **Retry setup**
- announcement: **Setting up message encryption. Sending is paused.**

When the local hello was sent but no peer key is present:

- label: **Waiting for partner**
- detail: **Both localhost browser clients must be online for the first key
  setup.**

### Encrypted, unverified

- label: **Encrypted · Unverified**
- detail: **Messages are encrypted to the peer public key currently connected.
  You have not confirmed who owns that key.**
- composer: enabled
- primary action: **Verify device**
- secondary action: **Encryption details**
- announcement: **Message encryption is active. Peer browser key is not
  verified.**

Keep **Unverified** visible. P-256 ECDH encrypts to the presented key, but an
active relay can substitute an unverified key. Do not say **secure person**,
**trusted contact** or **identity verified**.

### Encrypted, manually verified

- label: **Encrypted · Verified on this browser**
- detail: **You recorded that the complete 12-digit code matched on both
  browsers.**
- composer: enabled
- primary action: **View safety code**
- secondary action: **Clear verification**
- announcement: **Encryption active. Current peer browser key verified on this
  browser.**

This is a local user decision tied to the current room and public-key pair. It
does not verify a legal name, account, browser health or future replacement
key.

### Rekeying or key changed

The implemented frontend state is `key_changed`; present it as the rekeying
safety state requested by the interface.

- label: **Encryption: Key changed**
- detail: **The peer browser advertised a different key. Your previous
  verification no longer applies. Sending is paused.**
- composer: disabled
- placeholder: **Compare or accept the new key**
- primary action: **Compare new code**
- secondary action: **Continue encrypted but unverified**
- announcement: **Peer browser key changed. Previous verification no longer
  applies and sending is paused.**

The second action requires confirmation:

> Messages will be encrypted to the new public key, but you have not confirmed
> who owns it.

If a future build adds a distinct non-identity key-refresh state, use:

- label: **Encryption: Rekeying**
- detail: **Preparing new directional message keys. Sending is paused and your
  draft stays in this browser.**

Do not call same-key hello retry or same-static-key HKDF derivation forward
secret. This slice has no ratchet or ephemeral session handshake.

### Failed

- label: **Encryption failed**
- detail: **Message encryption could not be established. Sending is paused and
  no plaintext was sent.**
- composer: disabled
- placeholder: **Encryption unavailable**
- primary action: **Retry encryption**
- secondary action: **Leave room**
- announcement: **Encryption failed. Sending is paused. No plaintext was
  sent.**

There is no **Continue anyway** action. The room's `e2ee_required` lock remains
active after failure.

If a plaintext demonstration mode remains available, offer only:

> **Start a separate plaintext room**  
> This leaves the encrypted room. Messages in the new room can be read and
> stored by its server. Plaintext will not be added to this room.

Buttons: **Cancel** and **Leave and start plaintext room**.

### Plaintext

- label: **Chat: Plaintext**
- detail: **Messages are not end-to-end encrypted. The room server can read and
  store them.**
- composer: enabled only in a different legacy/plaintext room
- announcement: **Plaintext chat. Message encryption is off.**

This state must never be the fallback state of an `e2ee_required` room.

### Session-key fallback

This is a persistence qualifier, not a replacement encryption state.

- label: **Key lasts for this tab**
- detail: **This browser could not save its non-extractable room key. Refreshing
  or closing the tab creates a new browser key, changes the safety code and may
  make earlier messages unavailable.**
- action: **Learn why**

When IndexedDB persistence succeeds, technical details may say
**Non-extractable key saved in this browser**. Do not say permanent,
hardware-backed or impossible to copy.

### Unsupported direct LAN page

- label: **Encryption unavailable on this address**
- detail: **Open this app through localhost on each Mac, or use HTTPS. Direct
  LAN HTTP cannot run trusted browser encryption.**
- composer: disabled
- action: **Show two-Mac setup**

Both Macs run their own localhost browser client. Their backends relay
encrypted envelopes over the LAN.

## State evidence

The backend never reports verified or decrypted. Its evidence and local
evidence combine as follows:

| Evidence | Visible state |
| --- | --- |
| local identity generation or hello in progress | Setting up |
| local hello sent; no valid peer advertisement | Waiting for partner |
| two advertised keys but no locally derived context | Setting up or Failed, never encrypted |
| local directional AES keys active; no local record for current `key_id` | Encrypted · Unverified |
| local AES keys active; local record matches room and current `key_id` | Encrypted · Verified on this browser |
| peer public key differs from the remembered local peer key, including after room reopen | Encryption: Key changed |
| setup, ECDH, HKDF, AES-GCM or current-key validation fails | Encryption failed |

Connection loss does not turn encryption into plaintext. The header may show
**Connection: Offline** beside the last known encryption label, but the
composer is disabled because delivery is unavailable. A new peer key on
reconnect enters the changed-key state.

## Safety-code flow

### Entry points

- **Verify device** in the unverified state;
- **View safety code** in the locally verified state;
- participant or encryption details; and
- the changed-key warning.

### Dialog

Title: **Compare safety code**

Body:

> Compare this complete code with **{self-entered participant name}** in person
> or through a different trusted channel. Do not compare it inside this chat.

Code format:

> **1234 5678 9012**

Show all 12 digits in three selectable groups of four. Assistive technology
should read the three groups separately. Do not provide a shorter check.

Identity note:

> Names in this classroom app are self-entered. A matching code confirms the
> current pair of browser keys; it does not verify a legal identity.

Also show:

- **Your key:** shortened `public_key_id` for diagnosis only;
- **Their key:** shortened `public_key_id` for diagnosis only;
- **Key storage:** Saved in this browser or This tab only;
- **First verified here:** local date and time, when present; and
- expandable protocol details: P-256 ECDH, HKDF-SHA-256 and AES-256-GCM.

Short key identifiers are not sufficient verification. The safety code also
depends on the ECDH shared secret and current room/key transcript.

### Actions

1. **The complete codes match**
2. **The codes do not match**
3. **Not now**

Require this checkbox before the first action:

> I compared all 12 digits through a different trusted channel.

After confirmation:

> **Verified on this browser**  
> You recorded a match for this room and public-key pair at {date/time}.
> Verification is cleared when the key pair changes.

This record stays local. The backend does not confirm it and the other person
must make their own comparison decision.

### Mismatch

Title: **Codes do not match**

Body:

> Stop sending. You may be connected to another browser, a key may have
> changed, or the exchange may have been intercepted. Confirm the room and
> localhost setup with your partner.

Buttons: **Compare again** and **Leave room**. Sending remains paused. Do not
claim that an attack definitely occurred.

## Changed-key explanation

Title: **Their browser key changed**

Body:

> This can happen after browser data is cleared, when a session-only key is
> replaced, when a different browser or Mac is used, or when someone replaces
> a public key in transit. Your previous verification no longer applies.
> Sending is paused.

Actions:

1. **Compare new code**
2. **Continue encrypted but unverified**
3. **Leave room**

Do not say **Your contact updated their key**. The application has no
authenticated contact account and cannot know why it changed.

## Message status copy

Render a normal incoming bubble only after AES-GCM authentication and
decryption succeeds.

- **Encrypting…**: local encryption is running.
- **Accepted for encrypted relay**: `message_ack` confirms backend acceptance.
- **Delivered and decrypted**: show only if a future authenticated peer receipt
  is implemented.
- **Could not encrypt · not sent**: local encryption failed.
- **Message authentication failed**: an incoming envelope was rejected.
- **Earlier encrypted message unavailable**: this browser lacks the matching
  key, commonly after a session-key fallback and refresh.

Do not call `message_ack` delivered. The backend cannot know that the recipient
decrypted the message. Never render raw ciphertext as broken chat text.

## Room details

| Label | Value |
| --- | --- |
| Room policy | Encryption required |
| Message contents | Encrypted in each browser |
| Peer browser key | Unverified or verified here |
| Your key storage | Saved in browser or this tab only |
| Server history | Ciphertext only |
| Metadata | Visible to relay |
| Protocol Lab material | Not used for chat |
| Client address | Localhost on this Mac |

Supporting copy:

> The relay sees room and delivery metadata. Encryption does not protect a
> compromised Mac, browser or local application code.

## Protocol Lab boundary

Show this at the top and after each experiment result:

> **Teaching simulation only**  
> This room-hosted teaching experiment does not create, verify or change the
> keys used by chat. The endpoint-owned exchange is separately labelled and
> activates only after mutual confirmation.

Do not reuse chat-encryption locks in BB84 controls. Never label a passed QBER
sample **safe channel**, **secure**, **verified** or **attack free**.

## Exact server-error copy

| Code | Heading | Detail |
| --- | --- | --- |
| `e2ee_required` | Encryption required in this room | Plaintext messages are blocked. Wait for encrypted setup or retry it. |
| `e2ee_public_key_conflict` | Browser keys must be different | Both participants advertised the same key. Encryption setup stopped. |
| `e2ee_not_ready` | Encryption is not ready | Both current browser keys are required before sending. |
| `e2ee_key_mismatch` | Browser keys changed | This message used an older key pair. Sending is paused while setup restarts. |
| `e2ee_iv_reuse` | Repeated encryption IV rejected | This message was not accepted. Retry to rotate this browser key, then review the new safety code before sending. |
| `message_id_conflict` | Message retry conflict | This message ID was already used for different encrypted content. Nothing new was stored. |
| `validation_error` | Encryption data rejected | The setup or encrypted envelope did not match the supported format. |

Local errors:

| Condition | Heading | Detail |
| --- | --- | --- |
| direct LAN HTTP page | Encryption unavailable on this address | Open this app through localhost on each Mac, or use HTTPS. Direct LAN HTTP cannot run trusted browser encryption. |
| Web Crypto unavailable | Encryption unavailable | This browser cannot run the required cryptographic operations. |
| IndexedDB save failure | Key lasts for this tab | Encryption can continue, but refresh changes the browser key and code. |
| peer absent | Waiting for partner | Both localhost browser clients must be online for key setup. |
| invalid P-256 key | Peer key rejected | The advertised key was not valid for this encryption version. |
| AES-GCM authentication failure | Message authentication failed | No plaintext was shown. Sending is paused. |

Technical details may include a fixed non-secret support code. They must not
include plaintext, private/derived keys or unsanitized attacker-controlled
content.

## Accessibility

- Keep the full encryption label visible at 200 percent zoom and on the
  390-pixel mobile layout.
- Use text and icons together; never rely on color or a lock alone.
- Use `role="status"` for setup progress and successful transitions.
- Use `role="alert"` for failure, authentication failure and key change.
- Announce the new state and whether sending is available, not the whole
  header.
- Move focus to blocking failure and changed-key headings.
- Return focus to **Verify device** after the safety dialog closes.
- Make all 12 digits selectable, keyboard reachable and grouped for screen
  readers.
- Respect reduced motion and avoid a continuously animated lock.

## Wording rules

### Use

- encrypted between these two browsers
- encrypted, peer key unverified
- verified on this browser
- compare all 12 digits
- non-extractable browser key
- key lasts for this tab
- server stores ciphertext
- relay can see metadata
- sending paused
- no plaintext was sent
- Protocol Lab material is not used for chat

### Avoid

- quantum-secure chat
- completely secure
- trusted contact
- identity verified
- impossible to intercept
- forward secret
- ratcheted
- server cannot interfere
- permanent key
- hardware protected
- military-grade encryption
- 256-bit security
- QBER proves no attacker

## Small-screen priority

Keep information in this order:

1. encryption state;
2. whether sending is paused;
3. Unverified, changed-key or session-only warning;
4. Verify or Retry action;
5. connection state;
6. room code; and
7. Phase and algorithm details.

Never shorten **Encrypted · Unverified**, **Encryption failed** or
**Chat: Plaintext** to an icon.

## UX acceptance checks

- Connection and encryption vary independently in component tests.
- No encrypted state appears without matching local AES keys.
- No verified state appears without local action for the current `key_id`.
- The composer is disabled during setup, key change, failure and mismatch.
- `e2ee_required` failure never produces or accepts plaintext chat.
- Session-only key storage is visible before verification.
- Refresh/key replacement clears verification and shows changed-key copy.
- Peer-key replacement is detected after leaving and reopening the same room;
  accepting it updates local continuity state but remains unverified.
- Repeated-IV recovery rotates the local identity and requires review of the
  replacement safety code.
- All 12 safety-code digits are displayed and checked.
- Message/tamper errors reveal no plaintext or attacker-controlled content.
- Legacy plaintext bubbles are never relabeled as encrypted.
- Protocol Lab results never alter the encryption badge.
- Two localhost browsers, keyboard-only use, reduced motion, 200 percent zoom
  and the 390-pixel mobile viewport pass.

## Related document

See [PHASE4_E2EE_THREAT_MODEL.md](PHASE4_E2EE_THREAT_MODEL.md) for the wire
contract, cryptographic lifecycle, non-goals and required security tests.
