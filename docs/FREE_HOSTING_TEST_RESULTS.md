# Free-hosting deployment checks — 14 November 2026

The app is deployed at https://bb84-secure-chat.onrender.com on Render Free.
The local validation and the limited public checks are recorded separately below.
Full public two-participant acceptance is not yet established.

- Baseline before hosting changes: 183 frontend tests and 133 backend tests passed.
- Final frontend: 207 tests in 16 files passed; ESLint passed with zero warnings;
  TypeScript and Vite production build passed.
- Final backend: 167 tests passed, including 23 hosted-mode tests and 11 static
  entry-point/header tests. Executed with the existing backend test Docker image.
- Deployment Docker image built successfully. The runtime runs as UID 10001.
- Isolated hosted container on `http://localhost:8091`: HTML, health and hosted
  network response passed; static assets loaded; four security headers were
  present; unknown API routes returned JSON 404; real WebSocket presence and
  ping/pong passed. An explicitly empty allowed origin correctly stopped startup.
- The existing `scripts/docker_chat_smoke.mjs` passed against the hosted
  container using a Node 22 companion container. This exercised two WebSocket
  participants, Web Crypto ECDH/HKDF/AES-GCM, matching safety codes, decryption
  in both directions, ciphertext history, encrypted retries, plaintext-downgrade
  and IV-reuse rejection, a shared redacted BB84/post-processing result, and
  rejection of a third participant. Its older Nginx-labelled output refers here
  to the hosted FastAPI/static container; Nginx is not part of this image.
- Direct execution of that Node smoke command on the host was prevented by the
  local network sandbox. The companion-container execution above completed.

The existing LAN app on port 8080 and editorial preview on port 8090 were left
running. The hosting image has no access to their databases or volumes.

## Public deployment and executed checks

- Private GitHub repository: https://github.com/Aditya1z/bb84-secure-chat
- Deployed source commit: `4bd475426566244e0001a8f79444a9d64c9dd039`.
- All 131 source files were uploaded through the connected GitHub integration.
  The remote tree hash `1e307a97aa16c79f8c901b64144bed9368beb62c` exactly
  matches the previously tested local release, including dotfiles and file modes.
- Render service: `srv-dbs6lne1egvs73d010b0`; first deployment:
  `dep-dbs6loe1egvs73d0121g`. Free ($0/month), Singapore, Dockerfile
  `deploy/Dockerfile.render`, context `.`, health path `/api/health`.
  Auto-Deploy was visibly verified Off before submission. No paid resources,
  payment details, persistent disks, or external databases were added.
- Public HTTPS `/` returned 200. `/api/health` returned status and database `ok`.
- `/api/network` returned hosted mode, ready true, port 10000, and no advertised host.
- Unknown API path `/api/not-a-route` returned 404.
- HTML responses contained CSP, `nosniff`, frame denial and referrer policy.
- The public JavaScript asset loaded successfully and matched the local production
  build byte for byte (319,541 bytes, SHA-256
  `c4649ca62fe6b0e8ffcefc6e79f98352ffc1f96ed3c179fac01cf57e5a5207f5`).
- The public page rendered in Chrome. A fresh Incognito test participant entered
  a new room, showed Live, and correctly paused sending while awaiting a partner.
  This confirms a browser connection, but is not a full two-participant WSS test.

## Pending acceptance and execution blockers

Two independent browser participants, safety-code comparison, bidirectional
messages, encrypted media transfer, reconnect, and BB84 accepted/abort behavior
remain unverified on the public deployment. Restart acceptance is also pending.
Do not treat local tests or the user's separate interactive usage as execution of
these public acceptance checks.

The local Node protocol run failed before testing with DNS/network restrictions.
The environment rejected a request to run it with escalated network permissions.
A supplemental script is saved at `work/render_public_smoke.mjs`; it has **not**
passed on the public service. Its planned checks include encrypted PNG transfer,
WSS reconnect, and BB84 interception abort, in addition to the original suite.

Native browser automation repeatedly timed out or reported that the window was
unavailable; tab-specific browser navigation failed with a timeout configuration
error. These prevented completion after the first test participant connected.
Brave also encountered a local DNS failure. No encryption or LAN code was changed
to work around these test-environment limitations.

Public HTTP evidence is saved locally under `artifacts/hosting/render-public-*`.
The service is publicly reachable, but complete end-to-end acceptance is pending.

