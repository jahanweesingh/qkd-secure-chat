# One free public demo on Render

The supplied `render.yaml` runs the existing frontend, FastAPI backend, and WebSockets in **one Free web service**. Both people open the same public HTTPS address. They can use different networks; they do not run a backend or enter a private LAN address on their laptops.

This package is for a temporary major-project demonstration. It does not add a paid database, persistent disk, separate frontend host, or paid service.

## Current deployment

Public app: **https://bb84-secure-chat.onrender.com** (health endpoint verified
on 23 November 2026). The existing source repository is
https://github.com/jahanweesingh/qkd-secure-chat. The configured service is one
Free Docker web service in Singapore, with Auto-Deploy Off. See
[executed checks and remaining acceptance](FREE_HOSTING_TEST_RESULTS.md).

## Deploy the prepared project

1. Push the verified commit to the existing GitHub repository. Keep `.env`, `.env.lan`, local databases, captures and private data out of Git.
2. In the existing Render `bb84-secure-chat` service, choose **Manual Deploy → Deploy latest commit** after reviewing the commit. Do not create another service or change production settings as part of this code update.
3. The existing service uses `deploy/Dockerfile.render`, repository-root build context, and `/api/health`. Auto-Deploy remains off; the service is deployed manually.
4. After Render reports the deploy live, open the existing `https://bb84-secure-chat.onrender.com` address and verify `/api/health`.

The Blueprint does not need an API secret. At startup, `deploy/start-render.sh` uses Render's supplied `RENDER_EXTERNAL_URL` as the allowed browser origin unless you explicitly configure `ALLOWED_ORIGINS`. An explicit empty or wildcard value fails validation. See [Render's Blueprint fields](https://render.com/docs/blueprint-spec), [Docker deployment guide](https://render.com/docs/docker), and [default environment variables](https://render.com/docs/environment-variables).

For a custom domain, configure `ALLOWED_ORIGINS` with the exact origins you will use, separated by commas, such as `https://chat.example.com,https://your-service.onrender.com`. Do not add trailing slashes, paths, or `*`. HTTPS is necessary for browser cryptography on public hosts.

## Demonstrate chat on two laptops

1. Open the public URL on laptop A. Enter a display name, create a room, and copy its room code.
2. Open **the same public URL** on laptop B. Choose **Join room** and paste that code.
3. Wait for both browser keys to be exchanged. Compare the safety code directly with your partner and mark the codes as matching only when they actually match.
4. Send `hi` in both directions. Send a small image or video to demonstrate the existing encrypted attachment flow.
5. Open **Encryption demo → Live chat** to inspect actual ciphertext. The separate learning example shows disposable example keys; production chat keys remain private to the browsers.
6. In the BB84 lab, **Start BB84 key exchange** runs the endpoint-owned
   browser protocol. Both endpoints must complete mutual confirmation before
   new messages use the hybrid epoch. **Start BB84 Experiment** runs the
   separate room-hosted teaching experiment and does not change the chat key.

Hosted mode rejects LAN invitation codes and disables cross-server LAN relaying. The existing Docker Compose and LAN scripts still use their original local deployment path.

## What runs in the single service

- A Node 22 build stage compiles the existing React/Vite frontend. The runtime contains only compiled static assets, Python dependencies, and backend application code.
- Python 3.12 starts the existing FastAPI app with one Uvicorn worker on `0.0.0.0:$PORT`. One worker is required because participant presence and experiment coordination are held in memory.
- `backend/app/hosted.py` mounts frontend files after the existing API and WebSocket routes. Unknown `/api` and `/ws` HTTP paths return 404, never the frontend page.
- The hosted entry applies the existing Nginx CSP, `nosniff`, frame denial, and referrer policy to HTTP responses. The container runs as an unprivileged user. Uvicorn access logging is disabled.
- The root `.dockerignore` allows only build inputs. Local environment files, databases, Git history, artifacts, and `work/` are excluded from the image build context.

The browser performs ECDH, endpoint-owned BB84 processing and hybrid HKDF/AES-GCM locally. The backend relays protected BB84 control envelopes and stores message ciphertext and encrypted attachment bytes; it does not receive BB84 contributions or chat keys. It can see room codes, names, public keys, timestamps, and sizes. The room-hosted teaching simulation remains separate. Neither flow is physical QKD or a claim of quantum-secure encryption. The security assumptions in [the threat model](PHASE4_E2EE_THREAT_MODEL.md) still apply, including trust in the delivered browser code and correctly comparing safety codes.

## Free-service limits

Render's Free service sleeps after 15 minutes without inbound traffic, including WebSocket messages. A later request wakes it, which can take about a minute. Its local filesystem is ephemeral: SQLite history and encrypted uploads can disappear after sleep, restart, or redeployment. Free instances cannot attach persistent disks. Free-instance hours, bandwidth, and build-minute limits also apply; review account limits and spending settings before a public demonstration. [Render Free service documentation](https://render.com/docs/free)

Open the app a few minutes before presenting. Keep a local backup of the demo media and expect to create a fresh room after a restart. Do not rely on this service as permanent message storage. It remains a two-person demonstration with room-code access, not an authenticated account system or an abuse-resistant public messaging service.

## Test the deployment image locally

These commands use a separate image and port, leaving the usual LAN app on port 8080 alone:

```sh
docker build -f deploy/Dockerfile.render -t bb84-free-hosting .
docker run --rm --name bb84-free-hosting-check -p 127.0.0.1:8091:10000 \
  -e ALLOWED_ORIGINS=http://localhost:8091 bb84-free-hosting
```

Open `http://localhost:8091` in two browser profiles and follow the demonstration steps. This localhost address is only for the local image check; use the assigned HTTPS URL when hosted. In another terminal:

```sh
curl -fsS http://localhost:8091/api/health
curl -fsS http://localhost:8091/api/network
curl -I http://localhost:8091/
```

The network response should report `mode: "hosted"`, no advertised private IP, and readiness. The page response should contain the four security headers. Stop the temporary container with `docker stop bb84-free-hosting-check`.

Run the existing frontend suite (`cd frontend && npm test && npm run lint && npm run build`) and backend suite (`cd backend && pytest`) before publishing changes. Hosted routing/header tests are in `backend/tests/test_hosted_app.py`; hosted-origin and disabled-relay checks are in `backend/tests/test_hosted.py`.
