# Archived Phase 3 Minimal Chat Interface Redesign

> **Archived, not current product behavior:** every plaintext and “AES planned”
> statement below describes the completed Phase 3 checkpoint. The current
> Phase 4 build encrypts chat in the browsers. For its interface, use
> [PHASE4_SECURITY_UX.md](PHASE4_SECURITY_UX.md) and
> [PHASE_STATUS.md](PHASE_STATUS.md).

## Design goal

The interface is designed to feel like a small, dependable messaging app. It
uses warm neutral surfaces, restrained sage accents, simple icons and short
copy. The technical teaching material remains available, but it no longer
competes with the conversation.

The redesign follows four rules:

- Put the conversation first.
- Keep connection and encryption status separate.
- Reveal technical depth inside the Protocol Lab.
- Never imply that a successful simulation encrypts the chat.

## Main screens

### Welcome screen

- Gives one direct explanation of the project.
- Keeps Create room and Join room as the main actions.
- Shows whether this Mac can create a LAN invitation.
- States `Current protection: plaintext` beside the primary action.

### Conversation screen

- Uses a quiet two-column desktop layout.
- Keeps room details and participant presence in the left sidebar.
- Keeps the message list and composer visually dominant.
- Shows `Chat: Plaintext` beside a separate connection indicator.
- Collapses the sidebar into a drawer on smaller screens.

### Protocol Lab

The lab is presented as a readable notebook-style workspace. Its top status
map explains the complete project boundary before an experiment begins:

| Area | Visible status | Meaning |
| --- | --- | --- |
| Message transport | Plaintext, current | Messages are not encrypted by this application. |
| BB84 exchange | Software simulation | The server models the protocol for teaching. |
| Post-processing | Modeled on host | Temporary values are processed and discarded on the creator backend. |
| AES-256-GCM | Not active, planned phase | Message encryption is a future phase and is not claimed here. |

After a run, the result separates the sampled QBER decision from the four
post-processing stages. The interface then repeats `Chat encryption: Off` so
that a completed model cannot be mistaken for a secure conversation.

## Interaction and accessibility

- Primary controls provide large touch targets and visible keyboard focus.
- Status is communicated with words and icons, not color alone.
- Dialog focus is trapped and returned to its trigger when closed.
- Motion is brief and disabled when reduced motion is requested.
- The message view, sidebar and lab have no page-level horizontal overflow at
  the 390 by 844 mobile test size.
- Long room codes and message content wrap safely.

## Research basis

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) guided focus visibility, target
  sizing and non-color status communication.
- [Apple Human Interface Guidelines: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
  informed the adaptive hierarchy and progressive disclosure.
- [Signal safety-number guidance](https://support.signal.org/hc/en-us/articles/360007060632-What-is-a-safety-number-and-why-do-I-see-that-it-changed)
  reinforced the rule that a positive security indicator must represent an
  actual verification event. The archived Phase 3 build therefore used no
  secure-chat lock.

## Security boundary

That Phase 3 checkpoint was suitable for coursework and trusted local-network
demonstrations. Its chat messages and SQLite history were plaintext. The BB84
and post-processing views were educational software models. The current Phase
4 chat behavior is documented separately and must not be inferred from this
archive.
