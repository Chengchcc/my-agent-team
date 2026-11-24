#!/usr/bin/env bash
# Rebuild the web surface and restart its unit — without taking it down while
# the build runs.
#
# Why a script: this box is 2 cores / 8 GB. An uncapped `next build` once ran 70
# minutes at 0.9% CPU with RAM at 99% (the kernel then picks a victim - usually
# the backend). The heap cap below turns an OOM into a fast, legible failure.
# scripts/memguard.sh is the better tool when cgroup v2 is writable; inside a
# restricted container it is not, hence the NODE_OPTIONS cap.
#
# Why staging: `next start` serves `.next` as it is on disk. Building in place
# deletes the chunks the running server is still handing out, so every page
# load during the build died with ChunkLoadError (2026-11-24, twice). The build
# writes to `.next-stage`; only a complete build (BUILD_ID present) is swapped
# in, by two renames, right before the restart. The outage is the restart.
#
# Usage: bash scripts/rebuild-web.sh
set -euo pipefail

cd "$(dirname "$0")/../apps/web"

STAGE=".next-stage"
PREV=".next-prev"

rm -rf "$STAGE"
echo "rebuild-web: next build (heap cap 2048M, into $STAGE)"
NODE_OPTIONS="--max-old-space-size=2048" NEXT_DIST_DIR="$STAGE" node node_modules/next/dist/bin/next build

[ -s "$STAGE/BUILD_ID" ] || { echo "rebuild-web: FAIL — no BUILD_ID in $STAGE, keeping the running build" >&2; exit 1; }
echo "rebuild-web: build complete $(cat "$STAGE/BUILD_ID"), swapping"

rm -rf "$PREV"
# An `if`, not `[ -d .next ] && …`: under `set -e` a false test in an AND-list
# would exit right here, with the fresh build still unswapped.
if [ -d .next ]; then mv .next "$PREV"; fi
mv "$STAGE" .next
# `next start` reads the build's recorded distDir; it must name where the build
# now lives.
sed -i "s#\.next-stage#.next#g" .next/required-server-files.json
echo "rebuild-web: restarting my-agent-team-web.service"
if ! systemctl restart my-agent-team-web.service; then
  echo "rebuild-web: restart failed — restoring the previous build" >&2
  rm -rf .next && mv "$PREV" .next
  systemctl restart my-agent-team-web.service
  exit 1
fi
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:3001/login; then
    echo "rebuild-web: up (HTTP 200 on /login)"
    rm -rf "$PREV"
    exit 0
  fi
  sleep 1
done
echo "rebuild-web: unit restarted but /login did not answer in 30s — previous build kept in $PREV" >&2
systemctl --no-pager status my-agent-team-web.service | tail -20 >&2
exit 1
