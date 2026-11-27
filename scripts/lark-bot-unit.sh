#!/usr/bin/env bash
# Launch ONE agent's Lark bot. Written for the systemd template unit
# `<prefix>-lark-bot@.service`, which supplies the variables below through an
# EnvironmentFile the backend writes before `systemctl start`.
#
# Optional flags are omitted when empty on purpose: the bot treats "no value"
# and "empty string" differently (an empty display name disables group
# @-mention detection instead of falling back to the default), so this script
# must not pass `--flag ""`.
set -euo pipefail

: "${LARK_BOT_AGENT_ID:?LARK_BOT_AGENT_ID is required}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_BUN="$(command -v bun 2>/dev/null || echo "${HOME:-/root}/.bun/bin/bun")"

args=(--agent-id "$LARK_BOT_AGENT_ID")
if [ -n "${LARK_BOT_BACKEND_URL:-}" ]; then args+=(--backend-url "$LARK_BOT_BACKEND_URL"); fi
if [ -n "${LARK_BOT_STATE_ROOT:-}" ]; then args+=(--state-root "$LARK_BOT_STATE_ROOT"); fi
if [ -n "${LARK_BOT_PROFILE:-}" ]; then args+=(--lark-profile "$LARK_BOT_PROFILE"); fi
if [ -n "${LARK_BOT_DISPLAY_NAME:-}" ]; then args+=(--bot-display-name "$LARK_BOT_DISPLAY_NAME"); fi
if [ -n "${LARK_BOT_WEB_URL:-}" ]; then args+=(--web-url "$LARK_BOT_WEB_URL"); fi

exec "${LARK_BOT_BUN:-$DEFAULT_BUN}" run "${LARK_BOT_ENTRY:-$ROOT/apps/lark-bot/src/main.ts}" "${args[@]}"
