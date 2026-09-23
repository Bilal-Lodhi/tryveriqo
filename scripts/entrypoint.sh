#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Assessment container entrypoint.
#
# Starts the MCP tool transport on an internal port, then the API on $PORT.
# The API is the supervised process; SIGTERM is forwarded to both.
#
# Configuration is validated by the API itself: in production it refuses to
# start without ASSESSMENT_API_TOKEN, ASSESSMENT_SESSION_SECRET,
# CORS_ALLOWED_ORIGINS and an AI credential. When it does, this container exits
# non-zero so the failure is visible to orchestration rather than masked.
# ─────────────────────────────────────────────────────────────────────────────
set -e

PORT="${PORT:-8080}"
MCP_PORT="${MCP_PORT:-3001}"
MCP_PID=""

echo "[entrypoint] environment=${ENVIRONMENT:-production}"
echo "[entrypoint] API on 0.0.0.0:${PORT}"

stop_transport() {
  if [ -n "${MCP_PID}" ]; then
    kill -TERM "${MCP_PID}" 2>/dev/null || true
    wait "${MCP_PID}" 2>/dev/null || true
  fi
}

shutdown() {
  echo "[entrypoint] Shutting down"
  stop_transport
  exit "${EXIT_CODE:-0}"
}

trap shutdown SIGTERM SIGINT

if [ "${ASSESSMENT_MCP_IN_PROCESS:-true}" = "true" ]; then
  echo "[entrypoint] MCP tool transport on 127.0.0.1:${MCP_PORT}"
  MCP_PORT="${MCP_PORT}" node ./packages/mcp-mongodb/dist/http-server-main.js &
  MCP_PID=$!
  echo "[entrypoint] MCP transport pid=${MCP_PID}"

  # The tool surface is required, so wait for it to answer before the API tries
  # to call it. If it never answers, fail rather than start a half-dead container.
  ready="false"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if ! kill -0 "${MCP_PID}" 2>/dev/null; then
      echo "[entrypoint] ERROR: MCP transport exited during startup" >&2
      EXIT_CODE=1
      shutdown
    fi
    if curl -sf "http://127.0.0.1:${MCP_PORT}/health" >/dev/null 2>&1; then
      ready="true"
      echo "[entrypoint] MCP transport is answering"
      break
    fi
    sleep 1
  done

  if [ "${ready}" != "true" ]; then
    echo "[entrypoint] ERROR: MCP transport did not become ready" >&2
    EXIT_CODE=1
    shutdown
  fi
fi

MCP_SERVER_ENDPOINT="${MCP_SERVER_ENDPOINT:-http://127.0.0.1:${MCP_PORT}}" \
  node ./apps/api/dist/index.js &
API_PID=$!
echo "[entrypoint] API pid=${API_PID}"

# Supervise: whichever process exits first decides the container's fate. The
# API's exit code is the one that matters, so it is preserved.
#
# This polls liveness explicitly rather than using `wait -n`. Under BusyBox ash
# (the shell in the Alpine runtime image) `wait -n` does not return when a
# tracked child dies *after* it has started blocking — reproduced against this
# image. A container built on it therefore never noticed the tool transport
# dying: it kept serving an API whose datastore calls could no longer succeed.
# Polling `kill -0` is portable and is what makes the supervision real.
set +e
API_ALIVE=0
MCP_ALIVE=0

while :; do
  kill -0 "${API_PID}" 2>/dev/null && API_ALIVE=1 || API_ALIVE=0
  if [ -n "${MCP_PID}" ]; then
    kill -0 "${MCP_PID}" 2>/dev/null && MCP_ALIVE=1 || MCP_ALIVE=0
  else
    MCP_ALIVE=0
  fi

  [ "${API_ALIVE}" -eq 0 ] && break
  [ -n "${MCP_PID}" ] && [ "${MCP_ALIVE}" -eq 0 ] && break

  sleep 1
done

if [ "${API_ALIVE}" -eq 0 ]; then
  # The API is the supervised process; its exit code is the container's.
  wait "${API_PID}" 2>/dev/null
  EXIT_CODE=$?
else
  echo "[entrypoint] ERROR: MCP transport exited unexpectedly" >&2
  kill -TERM "${API_PID}" 2>/dev/null || true
  wait "${API_PID}" 2>/dev/null
  EXIT_CODE=1
fi
set -e

echo "[entrypoint] API exited with code ${EXIT_CODE}"
shutdown
