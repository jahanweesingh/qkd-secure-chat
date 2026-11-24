# Frontend polish — 12 November 2026

The refreshed app is running at **http://localhost:8088** in the existing
isolated `bb84-upgrade-check` Compose project. The original stack on port 8080
was not changed. Refresh the page to load the new frontend.

## Visible improvements

- A deep green welcome panel with a conceptual browser-to-browser exchange,
  clearer typography, and a focused create/join form. No simulated messages,
  key values or pretend encryption results were added to this illustration.
- A pale sage room sidebar and an inset white conversation workspace, with
  more readable message bubbles, participants, room codes and timestamps.
- A two-row mobile header that keeps encryption, connection and BB84 labels
  readable. Obsolete CSS that clipped the labels was removed.
- A sidebar shortcut to the existing BB84 Security Lab. Both entry points
  open the same experiment; closing returns focus to the visible header button.
- Protection-card colors now follow the actual encryption state: verified,
  unverified, waiting, changed key or failed. Color never sets verification.
- A message composer that expands with a multiline draft up to 160px and
  scrolls beyond that; clearing or sending reduces it to its initial height.
- Join-form validation focuses the invalid field and associates its error
  with that field for assistive technology. Entered values remain intact.
- Consistent security-drawer spacing, lab participant cards, result metrics,
  focus indicators and global scrollbars, with reduced-motion/forced-color rules.

## Preserved boundaries

The backend, WebSocket contract, LAN routing, `e2ee.ts`, and `useChat.ts` were
not edited in this pass. No dependency was added. Encryption and verification
still use their existing checks; a successful lab run does not change AES keys.
The integration remains deferred as described in
[BB84_AES_INTEGRATION_PLAN.md](BB84_AES_INTEGRATION_PLAN.md).

## Verification executed

| Check | Result |
| --- | --- |
| Existing frontend baseline | 75 tests passed before the new interaction tests |
| Final `npm test` | **77 tests passed across 5 files** |
| `npm run lint` | Passed |
| `npm run build` (includes TypeScript) | Passed locally and in the production Docker build |
| Two independent Chromium profiles against production | Passed |
| Strict premium UI audit | Zero findings |
| DESIGN.md lint | Zero errors and warnings |
| Running backend/database health | Healthy |

Browser coverage includes bidirectional encrypted messaging, ciphertext-only
history, refresh/decryption recovery, manual verification, changed-key send
blocking, all seven actual BB84 stages, rejection and insufficient-material
outcomes, chat after experiments, modal keyboard handling, sidebar lab entry,
validation focus, growing/shrinking drafts and mobile technical details.

Welcome overflow was checked at 320, 390 and 768px; chat/header at 320 and 390px;
desktop screenshots use 1440px. The lab also ran under reduced-motion emulation.
Screenshot review caught clipped mobile labels; the final browser run now checks
their clipping and visibility in addition to their dimensions. Both browser
consoles were free of errors and warnings.

**Evidence availability:** The original report refers to a browser report,
thirteen screenshots and a static audit under `artifacts/frontend-polish/`.
Those files are not included in this checkout, so the visual evidence cannot be
reviewed here. No replacement screenshots or report results are asserted.

This pass did not repeat the unchanged backend unit suite or physical two-Mac
tests. The previous backend/relay results remain in
[SECURITY_LAB_UPGRADE.md](SECURITY_LAB_UPGRADE.md). This is not a full screen-reader,
Safari, physical touch-device or cryptographic audit.

## Changed files and rollback

Production changes: `frontend/src/App.tsx`, `frontend/src/styles.css`, and
`frontend/src/security-lab.css`. The existing final presentation layer was
replaced; crypto code and the application framework were preserved.

The original report also names a pre-polish source archive, backup notes and a
disposable preview configuration/browser harness under `backups/` and
`artifacts/upgrade-ui/`. Those files are not included in this checkout; the
preview procedure cannot be run from this copy. The report's historical source
change summary is retained above.
