#!/bin/sh
set -eu

: "${GEMMA_MODEL:=gemma4:e2b}"

ollama serve &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' INT TERM

attempt=0
until env OLLAMA_HOST=127.0.0.1:11434 ollama list >/dev/null 2>&1; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    printf '%s\n' "ollama_start_timeout" >&2
    exit 1
  fi
  sleep 2
done

if ! env OLLAMA_HOST=127.0.0.1:11434 ollama show "$GEMMA_MODEL" >/dev/null 2>&1; then
  env OLLAMA_HOST=127.0.0.1:11434 ollama pull "$GEMMA_MODEL"
fi
wait "$server_pid"
