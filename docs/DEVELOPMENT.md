# Development and configuration

This guide contains the configuration and local development instructions
previously included in the main README.

## Configuration

Copy `.env.example` to `.env` and change values only when needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEPLOYMENT_MODE` | `local` | `hosted` requires explicit origins and disables LAN relay |
| `APP_PORT` | `8080` | Host port used by the local web interface; hosted startup uses Render's `PORT` |
| `BIND_ADDRESS` | `127.0.0.1` | Local-only bind; LAN helper changes it to `0.0.0.0` |
| `LAN_ADVERTISE_IP` | unset | RFC1918 address encoded into LAN invitation codes |
| `DATABASE_PATH` | `/data/chat.db` | SQLite path inside the backend container |
| `ALLOWED_ORIGINS` | localhost origins | Allowed browser WebSocket/HTTP origins |
| `MAX_MESSAGE_LENGTH` | `2000` | Legacy plaintext character cap; Phase 4 envelope limit is fixed at 4,096 UTF-8 bytes and the current composer remains 2,000 characters |
| `HISTORY_LIMIT` | `100` | Maximum history records returned |

If port 8080 is busy, set `APP_PORT=8090` in `.env` and include the matching
origin, such as `http://localhost:8090`, in `ALLOWED_ORIGINS`.

## Local development without Docker

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
DATABASE_PATH=./data/chat.db ALLOWED_ORIGINS=http://localhost:5173 \
  uvicorn app.main:app --reload
```

Frontend, in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Vite opens the development interface at `http://localhost:5173` and proxies
API and WebSocket traffic to the backend on port 8000.

## Docker services

The frontend is served by Nginx on port 8080. Nginx forwards `/api` and `/ws`
to the private FastAPI container. SQLite data is held in the named Docker
volume `bb84-secure-chat_chat-data`. For the Compose test profile and
verification commands, see [Testing](TESTING.md).
