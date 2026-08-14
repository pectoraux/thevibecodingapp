#!/bin/bash
# Start the execution worker with a CLEAN environment (no platform secrets).
env -i \
  PATH="/usr/local/bin:/usr/bin:/bin:/home/z/.bun/bin:/home/z/.local/bin" \
  HOME="/home/z" \
  USER="z" \
  SHELL="/bin/bash" \
  LANG="en_US.UTF-8" \
  TERM="xterm-256color" \
  TMPDIR="/tmp" \
  bun run dev
