#!/usr/bin/env bash
# Install (or refresh) the systemd units this repo ships in deploy/systemd/.
#
#   sudo scripts/install-systemd.sh
#
# Idempotent: copies, daemon-reloads, enables the two long-running units, and
# restarts only the ones whose file actually changed. The per-agent bot unit is
# a TEMPLATE - it is not enabled here on purpose: the backend starts and stops
# it (ADR 0068), and enabling it at boot would start bots the app has disabled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/deploy/systemd"
DEST="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

[ -d "$SRC" ] || { echo "install-systemd: $SRC is missing" >&2; exit 1; }
[ -w "$DEST" ] || { echo "install-systemd: $DEST is not writable (run as root)" >&2; exit 1; }

changed=()
for unit in my-agent-team-backend.service my-agent-team-web.service 'my-agent-team-lark-bot@.service'; do
  if ! cmp -s "$SRC/$unit" "$DEST/$unit"; then
    install -m 0644 "$SRC/$unit" "$DEST/$unit"
    changed+=("$unit")
    echo "installed $unit"
  fi
done

systemctl daemon-reload
systemctl enable my-agent-team-backend.service my-agent-team-web.service >/dev/null 2>&1 || true

if [ "${#changed[@]}" -gt 0 ]; then
  for unit in "${changed[@]}"; do
    case "$unit" in
      *'@.'*) continue ;;  # template: no instance to restart; the backend controls instances
      *) systemctl restart "$unit" ;;
    esac
  done
fi

echo "done: $(systemctl is-active my-agent-team-backend.service) backend, $(systemctl is-active my-agent-team-web.service) web"
