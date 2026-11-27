#!/usr/bin/env bash
# Render and install the systemd unit templates from deploy/systemd/*.template.
#
#   sudo scripts/install-systemd.sh
#
# Optional overrides:
#   SYSTEMD_USER            User account to run the units (default: SUDO_USER or current user)
#   SYSTEMD_UNIT_PREFIX     Unit name prefix (default: my-agent-team)
#   SYSTEMD_UNIT_DIR        Target systemd directory (default: /etc/systemd/system)
#   SYSTEMD_WEB_MEMORY_MAX  MemoryMax for the web unit (default: 3400M)
#   BUN_BIN                 Explicit path to the bun binary (default: auto-detected)
#
# Idempotent: renders templates for the current repo path, copies only changed
# units, reloads systemd, enables backend + web, and restarts changed long-lived
# units. The per-agent Lark bot template unit is intentionally NOT enabled here
# because the backend starts and stops instances on demand (ADR 0068).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/deploy/systemd"
DEST="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
UNIT_PREFIX="${SYSTEMD_UNIT_PREFIX:-my-agent-team}"
RUN_USER="${SYSTEMD_USER:-${SUDO_USER:-$(id -un)}}"
RUN_HOME="${SYSTEMD_HOME:-$(getent passwd "$RUN_USER" | cut -d: -f6 || true)}"
RUN_HOME="${RUN_HOME:-$HOME}"
BUN_BIN="${BUN_BIN:-$(command -v bun 2>/dev/null || echo "$RUN_HOME/.bun/bin/bun")}"
BUN_DIR="$(dirname "$BUN_BIN")"
WEB_MEMORY_MAX="${SYSTEMD_WEB_MEMORY_MAX:-3400M}"

[ -d "$SRC" ] || { echo "install-systemd: $SRC is missing" >&2; exit 1; }
[ -w "$DEST" ] || { echo "install-systemd: $DEST is not writable (run as root)" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

render_template() {
  local tpl="$1"
  local out="$2"
  sed \
    -e "s|@REPO_DIR@|$ROOT|g" \
    -e "s|@RUN_USER@|$RUN_USER|g" \
    -e "s|@RUN_HOME@|$RUN_HOME|g" \
    -e "s|@BUN_BIN@|$BUN_BIN|g" \
    -e "s|@BUN_DIR@|$BUN_DIR|g" \
    -e "s|@UNIT_PREFIX@|$UNIT_PREFIX|g" \
    -e "s|@WEB_MEMORY_MAX@|$WEB_MEMORY_MAX|g" \
    "$tpl" > "$out"
}

declare -A MAP=(
  ["backend.service.template"]="${UNIT_PREFIX}-backend.service"
  ["web.service.template"]="${UNIT_PREFIX}-web.service"
  ["lark-bot@.service.template"]="${UNIT_PREFIX}-lark-bot@.service"
)

changed=()
for tpl in backend.service.template web.service.template 'lark-bot@.service.template'; do
  unit="${MAP[$tpl]}"
  rendered="$TMP/$unit"
  render_template "$SRC/$tpl" "$rendered"
  if ! cmp -s "$rendered" "$DEST/$unit"; then
    install -m 0644 "$rendered" "$DEST/$unit"
    changed+=("$unit")
    echo "installed $unit (repo=$ROOT user=$RUN_USER)"
  fi
done

systemctl daemon-reload
systemctl enable "${UNIT_PREFIX}-backend.service" "${UNIT_PREFIX}-web.service" >/dev/null 2>&1 || true

if [ "${#changed[@]}" -gt 0 ]; then
  for unit in "${changed[@]}"; do
    case "$unit" in
      *'@.'*) continue ;;  # template: no instance to restart; the backend controls instances
      *) systemctl restart "$unit" ;;
    esac
  done
fi

echo "done: $(systemctl is-active "${UNIT_PREFIX}-backend.service") backend, $(systemctl is-active "${UNIT_PREFIX}-web.service") web"
