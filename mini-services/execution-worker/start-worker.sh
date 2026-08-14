#!/bin/bash
# Start the execution worker with a CLEAN environment (no platform secrets).
# The worker needs ONLY:
# - PATH (to find bun, git, npm, etc.)
# - HOME, USER, SHELL (basic process needs)
# - FORGE_WORKER_SECRET (shared secret for HMAC token verification)
#
# It does NOT get DATABASE_URL, NEXTAUTH_SECRET, FORGE_MASTER_KEY, GITHUB_PAT, etc.
env -i \
  PATH="/usr/local/bin:/usr/bin:/bin:/home/z/.bun/bin:/home/z/.local/bin" \
  HOME="/home/z" \
  USER="z" \
  SHELL="/bin/bash" \
  LANG="en_US.UTF-8" \
  TERM="xterm-256color" \
  TMPDIR="/tmp" \
  FORGE_WORKER_SECRET="${FORGE_WORKER_SECRET:-forge-worker-shared-secret-phase4}" \
  bun run dev
