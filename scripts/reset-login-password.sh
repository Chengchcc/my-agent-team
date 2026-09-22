#!/usr/bin/env bash
set -euo pipefail

# ── reset-login-password ────────────────────────────────────────────────────
# Recovery for a forgotten console password in a SOURCE checkout.
#
# The login password lives in the stack's own database (settings.auth.password_hash)
# and the env value is only a bootstrap credential, so "forgot it" means "ask the
# backend to drop the stored one and adopt a value I know".
#
#   bash scripts/reset-login-password.sh                  # use MOCK_PASSWORD from apps/web/.env
#   bash scripts/reset-login-password.sh 'new-password-1' # or pick one (>= 8 chars)
#
# This script does NOT write the database — the backend is its only writer. It
# drops the reset marker next to it, and the backend consumes that on the next
# start. Restart the backend afterwards.
#
# Gateway installs use `oma gateway passwd`, which leaves the same marker.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${BACKEND_DATA_DIR:-$ROOT/apps/backend/.backend-data}"
ENV_FILE="$ROOT/apps/web/.env"
BACKEND_ENV="$ROOT/apps/backend/.env"

PASSWORD="${1:-}"
if [ -z "$PASSWORD" ] && [ -f "$ENV_FILE" ]; then
  PASSWORD="$(grep -E '^MOCK_PASSWORD=' "$ENV_FILE" | head -n1 | sed -E 's/^MOCK_PASSWORD=//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//' || true)"
fi
if [ -z "$PASSWORD" ]; then
  echo "no password given and none found in $ENV_FILE" >&2
  echo "usage: bash scripts/reset-login-password.sh ['new-password']" >&2
  exit 1
fi
if [ "${#PASSWORD}" -lt 8 ]; then
  echo "refusing: the password must be at least 8 characters (got ${#PASSWORD})" >&2
  exit 1
fi

# Write the chosen value where the BACKEND reads its bootstrap credential (it is
# the process that hashes it), and keep web's copy in step so the pre-seed
# fallback does not disagree. Done through bun, not sed: the value is arbitrary
# text and sed would interpolate `&`, `|` and backslashes.
PW="$PASSWORD" ENV_FILE="$ENV_FILE" BACKEND_ENV="$BACKEND_ENV" bun -e '
const { readFileSync, writeFileSync, existsSync, chmodSync } = require("node:fs");
const upsert = (path, key, value) => {
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, "utf8").split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(`${key}=${value}`);
  }
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o600);
  return true;
};
const web = upsert(process.env.ENV_FILE, "MOCK_PASSWORD", process.env.PW);
const backend = upsert(process.env.BACKEND_ENV, "MOCK_PASSWORD", process.env.PW);
console.log(`wrote MOCK_PASSWORD: web=${web} backend=${backend}`);
'

# Ask the backend to drop the stored hash. A file, not a database write: the
# backend owns its DB and may be running while this script is.
mkdir -p "$DATA_DIR"
date -Iseconds > "$DATA_DIR/password-reset"
echo "reset requested ($DATA_DIR/password-reset)"

echo ""
echo "restart the backend, then log in with: user-001 / ${PASSWORD}"
