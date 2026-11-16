---
version: alpha
name: QKD Chat Lab
description: A warm editorial café workspace for private conversation and practical encryption learning.
colors:
  primary: "#704b36"
  background: "#f7f3ec"
  surface: "#fffdf8"
  text: "#302a25"
  brand-deep: "#35281f"
  panel: "#eee6d9"
  muted: "#716657"
  success: "#3e6953"
  warning: "#805b22"
  danger: "#963a3d"
typography:
  sans:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
  display:
    fontFamily: "Georgia, Times New Roman, serif"
  mono:
    fontFamily: "ui-monospace, monospace"
rounded:
  sm: "10px"
  md: "16px"
  lg: "24px"
spacing:
  lab-gap: "16px"
components:
  welcome: { backgroundColor: "{colors.background}" }
  invitation: { backgroundColor: "{colors.surface}", textColor: "{colors.text}" }
  sidebar: { backgroundColor: "{colors.background}", textColor: "{colors.muted}" }
  ciphertext: { backgroundColor: "{colors.brand-deep}", textColor: "{colors.surface}" }
  mode-switch: { backgroundColor: "{colors.panel}", textColor: "{colors.muted}" }
  lab: { backgroundColor: "{colors.surface}", textColor: "{colors.text}", rounded: "{rounded.md}" }
  verified: { textColor: "{colors.success}" }
  caution: { textColor: "{colors.warning}" }
  failure: { textColor: "{colors.danger}" }
---

# QKD Chat Lab design context

## Overview

English-language classroom product for a mentor and students on desktop and
mobile. The chat remains the main experience. The lab feels like a guided
experiment notebook: Alice and Bob's encoding choices form its visual signature.
Avoid a research-paper layout, debug console or invented measurements. The user
explicitly chose **Warm editorial café**: cream canvas, ivory paper surfaces,
espresso accents and restrained serif titles. This is a spatial redesign of the
welcome page, conversation workspace, encryption studio and experiment notebook.
The user's later refinement removes the coffee image and keeps the plain
`qkd.` wordmark without the "chat & curiosity" tagline. The welcome spread is
text-only: typography, spacing and warm surfaces carry the identity. The
interface remains a working chat application, without café menus or unrelated
marketing sections. Real message text and ciphertext carry the teaching experience.

## Colors

The runtime source of truth is `frontend/src/styles.css` `:root`: primary maps
to `--app-green`, background to `--app-canvas`, surface to `--app-surface`, text
to `--app-ink`, warning to `--app-amber`, danger to `--app-red`. The retained
`--app-green` name is a compatibility alias for the coffee primary, not a green
brand color. The coffee-house token block in styles.css owns the final values:
brand-deep maps to `--app-brand-deep`, panel to `--app-panel`, muted to
`--app-muted`, and success to `--app-success`. Components consume these tokens;
they must not copy palette values into independent themes. Semantic verification
and success remain green (#3e6953); amber means caution and red means failure.
Words always accompany status colors. No decorative coffee image is rendered
or served by the application, and no remote font or theme dependency is required.

## Typography

Use `--app-display` (Georgia / Times New Roman / serif) for welcome, empty-state
and teaching titles, plus the short original/decrypted text in the teaching
strip. Use `--app-ui` (Inter / system sans fallbacks) for navigation,
controls and ordinary prose. The conversation heading also uses Georgia. Keep
serif display type restrained; room
codes, ciphertext and cryptographic values use monospace. No remote font loads.
Body copy stays readable at mobile widths, with tabular numerals for measured
results and sentence-style headings.

## Layout

The welcome view is a text-only editorial spread: a plain `qkd.` masthead above
a large title and short introduction on the left, an ivory invitation containing
the existing room form on the right. The spread stacks on mobile. `CafeWelcome` is a
presentation wrapper; validation, joining and form state remain in `App.tsx`.

The joined room has a global masthead, followed by a wide conversation on the
left and a narrow Room notes column on the right. A serif conversation heading
introduces the ivory message sheet and composer. Room notes contain participants,
the room code and connection details; they become a right-side drawer on compact
screens. The masthead separates navigation and learning tools from connection
and encryption status. There is one entry to each learning area.
The message composer grows with its contents up to 160px and then scrolls.
A paperclip opens the native file picker; one image/video is previewed before
Send file. No drop-zone or permanent upload panel competes with the conversation.
The compact message state "Relayed" means server acceptance, never recipient decryption.
Repeated sidebar security/lab cards, routine unverified banners and
footer encryption slogans are removed. Necessary failure, changed-key and
session-only warnings stay visible. Mechanism explanations live inside the
existing SecurityPanel technical disclosure.
The encryption studio is a wide native dialog, up to 1280px. A roughly 280px
control rail holds the mode, message and action; the adjacent result sheet holds
the connected message journey and learning-key receipt. Additional keys use a
native disclosure. Advanced observations and the packet guide sit below the
result sheet in a low-emphasis Further reading row. Controls stack above results
on narrower screens; the three-stage strip then stacks on mobile. Values wrap
without shortening ciphertext or keys, and main controls have 44px minimum targets.

The BB84 result uses a notebook layout with a seven-stage index on the left and
the selected explanation on the right. Preserve the lab's modal shell, bounded
scrolling body, settings and mobile stacking. The show-all control remains
available. The progress bar means review position, never simulation completion.
Advanced settings and the diagnostic report stay in native disclosures.

## Elevation & Depth

Reuse the existing modal shadow and restrained borders. Results do not float on
new decorative layers. No ambient animation; no timer-driven fake progress.

## Shapes

Reuse the runtime `--radius-sm`, `--radius-md`, `--radius-lg` values above.
Encoding badges use two recognizable symbols with text alternatives.

## Components

`AttachmentMessage` owns explicit fetch/decrypt/open, retry and safe image/video
rendering. `attachments.ts` owns strict secret manifest parsing and file crypto;
raw manifests must never reach the DOM. The chat composer owns selection, preview,
cancellation and send gates. `SecurityPanel` owns device verification and the
expandable conceptual message-encryption explanation.

`CafeWelcome` and `cafe-welcome.css` own the text-only welcome spread and plain
`qkd.` wordmark. The discarded generated coffee image may remain archived at
`artifacts/presentation/cafe-note-original.png`; it is not part of the public app.

`SimpleEncryptionDemo` and `simple-encryption-demo.css` own the two-column
teaching workbench. "Try a message" labels the control rail; "Message journey"
labels the result sheet. Its connected three-stage strip has an espresso
ciphertext section with ivory text and arrows between actual stages. The
learning-key receipt sits below it, with additional values behind a disclosure.
The dialog title is "See what happens to “hi”". Learn with keys is a
local exercise; Live chat is a separate mode tied to current messages and
observations. Learning keys are intentionally inspectable and explicitly
separate from protected chat keys. `learningCrypto.ts` owns fresh demo-only
ECDH/HKDF/AES operations, with no production-key or network dependency. The
main chat and teaching surface share the coffee palette and typography.

`ProtocolLab` in `App.tsx` owns the existing modal and configuration. `LabRange` and native
select own settings; OS popup behavior is acceptable. Native details/summary own
disclosure. `SecurityLabWalkthrough` owns the new guided result view.
`ChatProtectionSummary` receives actual `EncryptionInfo`, connection and lab
state; it cannot infer encryption or verification from an experiment result.

The live presentation extends this notebook identity with an evidence path:
completed and unknown stages have distinct labels; dashed stages mean the browser
cannot observe that endpoint. Color alone never communicates completion.
`LiveSecurityView` consumes bounded observations from `useChat`; it cannot infer
remote decryption from a server acknowledgement or history replay. No fake
packet animation or timing interpolation is used. `PresentationDialog` is the
native HTML dialog variant for the interactive teaching workspace: the browser owns
Escape, background inertness and focus restoration; visible controls have
explicit Tab wrapping that skips closed disclosures. The
dialog and `presentation-dialog.css` own its gutters, scrolling and Further
reading row; the view consumes existing runtime tokens.
`EavesdroppingDemo` compares two actual preset results in the existing lab and
depicts recorded public basis/sample data. Its next/previous controls review
completed rows, not live transmissions. Existing security and lab modal owners
are unchanged; opening them closes the presentation first.

Existing security behavior is governed by `docs/PHASE4_SECURITY_UX.md` and
`docs/PHASE4_E2EE_THREAT_MODEL.md`. Preserve the existing security drawer.
Focus stays inside the lab, skips closed disclosures, and returns to its trigger.
Buttons have hover, focus and disabled states. Motion respects reduced motion.
Scrollbars remain visible, inherit the global tokenized baseline and defer to
system colors in forced-colors mode. Lab-specific CSS does not restyle the chat.
The header security badge uses the real encryption state for its semantic tone.

Canonical owners for this scope:

| Capability | Owner | Contract / evidence |
| --- | --- | --- |
| Welcome presentation | CafeWelcome / cafe-welcome.css | Pure wrapper; plain qkd. wordmark; text-only responsive editorial spread |
| Entry form | Onboarding in App.tsx | Preserve values on failure; focus and describe invalid field; App.test.tsx |
| Conversation workspace | App.tsx / cafe-workspace.css | Masthead, conversation and Room notes; compact drawer; imported last in main.tsx |
| Encryption studio | SimpleEncryptionDemo / PresentationDialog and their CSS | Control rail, result sheet, real values, native disclosures and focus handling |
| Select / ranges | Existing native select and LabRange | OS popup accepted; unchanged simulation settings |
| Security | SecurityPanel / encryptionCopy | PHASE4_SECURITY_UX.md; no verification inferred from color |
| Lab entry | ProtocolLab, opened from the header or teaching dialog | Escape returns to the visible header lab control |
| Lab result | SecurityLabWalkthrough / security-lab.css | Notebook index and actual report; review position is not simulated live progress |
| Scrolling | styles.css | Global thumb/track tokens, mobile layout; browser smoke |
| Feedback | Existing inline notices | Network, encryption, validation and experiments remain separate |

Reconciliation for this refinement: the user's explicit warm editorial café
choice determines both the palette and spatial hierarchy. Their later request
removes the image and tagline while retaining the warm typography and spacing.
The welcome spread,
global masthead, right-side notes, studio workbench and notebook index replace
the earlier layout rather than only recoloring it. Shared runtime tokens remain
the palette owner; verified-state green stays semantic. `cafe-workspace.css` is
imported last to own workspace layout overrides without changing protocol or
cryptographic state. Concise delivery copy and progressive disclosure reduce
repetition without removing verification controls or failure notices. See
`docs/TASTE_UI_REFINEMENT.md` for the skill provenance and acceptance record.

## Do's and Don'ts

- Show actual aggregate results and redacted basis traces only.
- Say “reviewing the completed result” when stepping through the returned report.
- Keep sample acceptance separate from final post-processing success.
- Never show production private keys, shared secrets or AES keys in the UI.
- Show fresh learning keys only in the explicitly separate local demonstration.
- Do not invent bit samples, ciphertext, simulation results or verification state.
- Keep chat encryption independent until a versioned integration is implemented.
