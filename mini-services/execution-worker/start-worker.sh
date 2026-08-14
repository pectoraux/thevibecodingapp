#!/bin/bash
# Start the execution worker with a CLEAN environment (no platform secrets).
# The worker needs:
# - PATH (to find bun, git, npm, etc.)
# - HOME, USER, SHELL (basic process needs)
# - FORGE_WORKER_SECRET (shared secret for HMAC token verification)
# - FORGE_CONTROL_PLANE_URL (where the Next.js control plane is running)
# - FORGE_WORKER_ID (unique identifier for this worker)
#
# It does NOT get DATABASE_URL, NEXTAUTH_SECRET, FORGE_MASTER_KEY, etc.
env -i \
  PATH="/usr/local/bin:/usr/bin:/bin:/home/z/.bun/bin:/home/z/.local/bin" \
  HOME="/home/z" \
  USER="z" \
  SHELL="/bin/bash" \
  LANG="en_US.UTF-8" \
  TERM="xterm-256color" \
  TMPDIR="/tmp" \
  FORGE_WORKER_SECRET="${FORGE_WORKER_SECRET:-forge-worker-shared-secret-phase4}" \
  FORGE_CONTROL_PLANE_URL="${FORGE_CONTROL_PLANE_URL:-http://localhost:3000}" \
  FORGE_WORKER_ID="${FORGE_WORKER_ID:-worker-$(date +%s)}" \
  bun run poller.ts
