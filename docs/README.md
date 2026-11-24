# Documentation

This index groups the project guides by task. Historical reports may describe
verification artifacts that are not included in this repository checkout; see
the note in each report before relying on its screenshots, measurements or
test results.

## Start and operate the application

- [Development and configuration](DEVELOPMENT.md) — environment variables,
  local development and Docker service details.
- [Local testing and verification](TESTING.md) — prerequisites, test commands
  and browser acceptance steps.
- [LAN setup](LAN_SETUP.md) — connect two Macs over a private network.
- [Render hosting](FREE_HOSTING.md) — hosted demo setup and limitations.
- [Troubleshooting](TROUBLESHOOTING.md) — common Docker, room, connection and
  encryption issues.
- [Panel demonstration](PANEL_DEMO.md) — timed classroom walkthrough.

## Understand the system

- [Architecture](ARCHITECTURE.md) — frontend, backend, relay and data flow.
- [API](API.md) — HTTP and WebSocket contracts.
- [Requirements](REQUIREMENTS.md) — project behavior and constraints.
- [Encrypted media](ENCRYPTED_MEDIA.md) — attachment encryption and handling.
- [Simple encryption demo](SIMPLE_ENCRYPTION_DEMO.md) — learning exercise and
  live chat observations.
- [Phase status](PHASE_STATUS.md) — implemented scope and known boundaries.

## Security and protocol limits

- [Security status](../SECURITY.md) — concise security summary.
- [E2EE threat model](PHASE4_E2EE_THREAT_MODEL.md) — trust model, key lifecycle
  and limitations.
- [Security UX](PHASE4_SECURITY_UX.md) — user-facing security language.
- [BB84 integration plan](BB84_AES_INTEGRATION_PLAN.md) — distinction between
  the room-hosted teaching simulation and chat key establishment.
- [Live security view](LIVE_SECURITY_VIEW.md) — what browser observations mean
  and what they cannot prove.

## Historical reports

These documents are retained for project history. Their described screenshots,
reports, backups or test harnesses are not necessarily present in this checkout.
A historical result is not a claim that the same check was run against the
current source.

The project report mentioned in the earlier handoff,
`docs/Project_Reference_Secure_Chat.docx`, is not present in this checkout.

- [Frontend polish report](FRONTEND_POLISH.md)
- [Encrypted media report](ENCRYPTED_MEDIA.md)
- [Taste and UI refinement](TASTE_UI_REFINEMENT.md)
- [Live security view report](LIVE_SECURITY_VIEW.md)
- [Free-hosting test notes](FREE_HOSTING_TEST_RESULTS.md)
- [Test result history](TEST_RESULTS.md)
- [UX security content](UX_SECURITY_CONTENT.md)
- [Simple encryption demo notes](SIMPLE_ENCRYPTION_DEMO.md)
