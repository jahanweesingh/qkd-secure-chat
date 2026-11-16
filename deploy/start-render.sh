#!/bin/sh
set -eu

# One public origin serves HTML, API requests, and WebSockets. Never use '*'.
if [ "${ALLOWED_ORIGINS+x}" != x ]; then
  : "${RENDER_EXTERNAL_URL:?Set RENDER_EXTERNAL_URL or an explicit ALLOWED_ORIGINS origin}"
  ALLOWED_ORIGINS="${RENDER_EXTERNAL_URL%/}"
fi

PORT="${PORT:-10000}"
export ALLOWED_ORIGINS
export DEPLOYMENT_MODE=hosted
export APP_PORT="$PORT"
unset LAN_ADVERTISE_IP

# Room presence and BB84 coordination are held in process: keep one worker.
# Access logs can include room/client identifiers, so keep them disabled.
exec uvicorn app.hosted:create_app --factory \
  --host 0.0.0.0 --port "$PORT" --workers 1 \
  --no-access-log --log-level warning
