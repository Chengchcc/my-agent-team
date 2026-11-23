#!/usr/bin/env bash
# Rebuild the web surface and restart its unit.
#
# Why a script: this box is 2 cores / 8 GB. An uncapped `next build` once ran 70
# minutes at 0.9% CPU with RAM at 99% (the kernel then picks a victim - usually
# the backend). The heap cap below turns an OOM into a fast, legible failure.
# scripts/memguard.sh is the better tool when cgroup v2 is writable; inside a
# restricted container it is not, hence the NODE_OPTIONS cap.
#
# Usage: bash scripts/rebuild-web.sh
set -euo pipefail

cd "$(dirname "$0")/../apps/web"

echo "rebuild-web: next build (heap cap 2048M)"
NODE_OPTIONS="--max-old-space-size=2048" node node_modules/next/dist/bin/next build

echo "rebuild-web: restarting my-agent-team-web.service"
systemctl restart my-agent-team-web.service
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:3001/login; then
    echo "rebuild-web: up (HTTP 200 on /login)"
    exit 0
  fi
  sleep 1
done
echo "rebuild-web: unit restarted but /login did not answer in 30s" >&2
systemctl --no-pager status my-agent-team-web.service | tail -20 >&2
exit 1
