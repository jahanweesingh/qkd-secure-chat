# Taste UI refinement

> Historical report from 13 November 2026: it describes the pre-hybrid chat
> state. For current BB84 + ECDH chat behavior, see
> [BB84_AES_INTEGRATION_PLAN.md](BB84_AES_INTEGRATION_PLAN.md).

The user explicitly chose **Warm editorial café**. The refinement changes the
layout of the application as well as its colors: cream canvas, ivory paper
surfaces, espresso accents and Georgia display headings. Controls and conversation
text remain sans serif; verified status retains its separate green meaning.
Palette tokens and component ownership are recorded in [DESIGN.md](../DESIGN.md).

The user's final direction keeps the warm editorial typography, spacing and
cream surfaces while removing the coffee image. The plain **qkd.** wordmark
remains; the "chat & curiosity" tagline is removed. The welcome page is a
text-only editorial spread with an ivory invitation form. `CafeWelcome` is a presentation-only wrapper
around the existing form; joining and validation still belong to `App.tsx`.
The joined workspace has a global masthead, a broad conversation on the left and
Room notes on the right. Notes become a drawer on compact screens. Learning
tools remain separate from connection and encryption status. Repeated security
cards and routine encryption slogans are removed; failed encryption, changed
keys, session-only storage and verification controls remain available.

**See what happens to “hi”** is now a wide workbench: a **Try a message** control
rail beside a **Message journey** result sheet. The connected message →
ciphertext → decrypted-message strip leads to a visible learning-key receipt.
Additional values stay in native disclosures. **Further reading** holds live
observations and the packet guide below the main results. The BB84 walkthrough
uses a notebook layout with a stage index on the left and the selected result
on the right; review controls do not imply live simulation progress.
**Learn with keys** performs real local encryption with
fresh demonstration keys; **Live chat** observes the existing conversation.
The short **Relayed** message status means backend acceptance, not proof of
recipient decryption. No crypto algorithm, backend contract or BB84-to-chat
relationship changed in this visual refinement.

`CafeWelcome` / `cafe-welcome.css` own the welcome layout. `cafe-workspace.css`,
imported last in `main.tsx`, owns the workspace layout. The studio is owned by
`SimpleEncryptionDemo`, `PresentationDialog` and their respective CSS files.
`SecurityLabWalkthrough` owns the notebook result. Existing state and protocol
owners remain in place.

The discarded generated coffee image remains an archived design artifact at
`artifacts/presentation/cafe-note-original.png` (1536×1024, 3142422 bytes). It is
not rendered or served in the public app. No coffee photo, remote image request
or remote font dependency is part of the final welcome page.

## Skill provenance and scope

The requested `Leonxlnx/taste-skill` was installed locally as version **2.5.1**
using `npx skills@1.8.1` and a downloaded GitHub archive at commit
`f6b76575f949707b4e3c37cd86cb44b0b98643e8`. Its installed directory is:

```text
work/design-skills/.agents/skills/design-taste-frontend
```

The direct `npx` installation attempt failed on DNS resolution. The global Codex
plugin marketplace installation also failed because it could not write under
`~/.codex`. The local skill was read and used for this refinement; a successful
global marketplace installation is not claimed.

Applied guidance includes one visual system, aligned content edges, plain copy,
fewer repeated facts, clearer type hierarchy, simpler surfaces and accessible
controls. The user's existing-application preservation requirements, minimalism
and explicit coffee identity take precedence over the skill's marketing-page
recipes. Georgia serves the chosen identity; the user's latest direction removes
the generated photograph and wordmark tagline. Random palettes, framework replacement, automatic marketing
hero recipes, photograph quotas, shader scenes and decorative timed animations
were not adopted. Necessary explanatory labels remain in this educational app.

## Verification record

Checks were executed on 13 November 2026. The final suite includes the text-only
welcome and plain QKD branding requested after the spatial redesign:

| Check | Actual result |
| --- | --- |
| Earlier frontend suite, before the spatial redesign | 180 passed |
| Earlier ESLint, TypeScript and production build | Passed |
| Earlier static design audit scoped to application source | Zero findings |
| Earlier Taste copy lint on saved demo-label inventory | Zero findings |
| Current App tests after the workspace changes | 40 passed |
| Current focused lab tests | 20 passed |
| Current encryption demo and dialog tests | 13 passed |
| Current scoped demo/dialog ESLint and TypeScript check | Passed |
| Final complete frontend suite | 183 tests passed across 16 files |
| Final ESLint | Passed with zero warnings |
| Final TypeScript and Vite production build | Passed |
| Final static design audit scoped to application source | Zero findings |
| DESIGN.md lint | Zero errors and zero warnings |
| Isolated preview frontend rebuild | Passed; backend and frontend healthy on port 8090 |
| Safari text-only welcome and plain QKD logo | Confirmed visually |
| Safari local learning example | Actual “hi” encryption and decryption completed; Escape closed studio |
| Safari BB84 comparison presets | Without Eve: 0/132 mismatches, accepted; with Eve: 33/132, rejected at 11% limit |
| Safari notebook navigation | Step 5 showed actual 25% error rate and stop explanation |

An unscoped audit produced 986 findings in vendored skill templates and examples.
Those files are tooling assets, not application source; the application audit
scope excludes them. A clean static audit does not establish browser or security
correctness. The official Taste browser gate has **not** been claimed as passed.
The copy-lint result covers `artifacts/presentation/taste-demo-copy.txt`, not the
full site or its browser interactions.

Final desktop screenshots are saved at
`artifacts/presentation/14-editorial-welcome.png` and
`artifacts/presentation/16-editorial-studio.png`. Earlier coffee-image screenshots
are superseded. The photo was removed from the public app, and both mastheads
retain only the QKD wordmark.

The mobile drawer's inert background, close/focus behavior and desktop resize
transition have automated coverage. A new mobile visual acceptance run and
two-browser message exchange were not completed for this final layout: the
Chrome tab connector returned a `timeoutMs` error, native Chrome rendering was
unreliable, and the Safari window later became unavailable. These limitations
are not recorded as passing browser checks. No new physical two-Mac acceptance
run, backend test run or packet capture is asserted here. The local skill
installation does not fix blocked global plugin registration. Software
simulation and ECDH-only chat limitations remain unchanged.

Preview: `http://localhost:8090`. The existing LAN stack on port 8080 was not
restarted or changed. The final assets are `index-DOe_OYqn.js` and
`index-D2NklDtF.css`; both returned HTTP 200, and `/api/health` reported OK.

A source backup is preserved at
`/private/tmp/bb84-before-taste-refinement-20261113.tar.gz`.

## Files and preserved behavior

Compared byte-for-byte with that backup, the modified frontend source files are
`App.tsx`, `App.test.tsx`, `PresentationDialog.tsx`,
`PresentationDialog.test.tsx`, `SecurityLabWalkthrough.tsx`,
`SecurityLabWalkthrough.test.tsx`, `SimpleEncryptionDemo.tsx`, `main.tsx`,
`presentation-dialog.css`, `security-lab.css`, `simple-encryption-demo.css` and
`styles.css`. New presentation files are `CafeWelcome.tsx`, `cafe-welcome.css`
and `cafe-workspace.css`. No source files were removed. Documentation updates
include `DESIGN.md`, this report, architecture, README, live-view/panel labels
and local skill provenance under `work/design-skills`.

`e2ee.ts`, `hooks/useChat.ts`, `learningCrypto.ts`, `attachments.ts` and all 12
backend application source files are unchanged against the backup. Existing
device identity, safety-code verification, key-change checks, encrypted media,
WebSocket events, LAN setup and fail-closed sending remain owned by those
existing implementations.

BB84 is still **not connected to chat AES key derivation**. The browsers exchange
public ECDH keys and derive matching directional AES keys locally through HKDF;
private keys and final chat keys are not transferred through the backend. The
server relays and stores encrypted chat/media payloads and sees operational
metadata such as room membership, timing and payload sizes. It separately runs
the classical BB84 simulation and therefore handles that simulation's temporary
material. The local learning example deliberately displays disposable example
keys; they never protect real chat messages. This visual redesign adds neither
physical quantum communication nor post-quantum security. The existing
documented authentication, browser trust and deployment limitations still apply.
