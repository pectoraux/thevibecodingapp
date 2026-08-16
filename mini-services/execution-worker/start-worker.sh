#!/bin/bash
# Start the execution worker with a CLEAN environment (no platform secrets).
# The worker needs:
# - PATH (to find bun, git, npm, etc.)
# - HOME, USER, SHELL (basic process needs)
# - FORGE_WORKER_SECRET (shared secret for HMAC token verification)
# - FORGE_CONTROL_PLANE_URL (where the Next.js control plane is running)
# - FORGE_WORKER_ID (unique identifier for this worker)
# - SUBSTRATE_SUPERVISOR_URL (where the substrate supervisor mini-service is
#   running — Phase 18X. The worker POSTs { capability, workload } here; the
#   supervisor holds the launcher key in memory and runs the substrate.)
#
# It does NOT get DATABASE_URL, NEXTAUTH_SECRET, FORGE_MASTER_KEY,
# FORGE_LAUNCHER_KEY_FILE, FORGE_LAUNCHER_PUBLIC_KEY, etc. The worker has
# NO access to the launcher private key — only the supervisor does.
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
  SUBSTRATE_SUPERVISOR_URL="${SUBSTRATE_SUPERVISOR_URL:-http://localhost:3004}" \
  bun run poller.ts
