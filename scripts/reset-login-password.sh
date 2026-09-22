#!/usr/bin/env bash
set -euo pipefail

# ── reset-login-password ────────────────────────────────────────────────────
# Recovery for a forgotten console password in a SOURCE checkout.
#
# The login password lives in the stack's own database (settings.auth.password_hash)
# and the env value is only a bootstrap credential, so "forgot it" means "clear
# the hash and let the next start adopt a known value".
#
#   bash scripts/reset-login-password.sh            # reset to MOCK_PASSWORD from apps/web/.env
#   bash scripts/reset-login-password.sh 'my-new-pw' # reset to a value you choose (>= 8 chars)
#
# The backend must be restarted afterwards (it caches the service; the value is
# re-read per login, but a restart is the honest instruction either way).
#
# For a gateway install (`oma gateway up`), use `oma gateway passwd` instead:
# it rotates the secret and clears the stored hash itself.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${BACKEND_DATA_DIR:-$ROOT/apps/backend/.backend-data}"
DB="${DATA_DIR%/}/backend.db"
ENV_FILE="$ROOT/apps/web/.env"

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

if [ ! -f "$DB" ]; then
  echo "no database at $DB"
  echo "it is created on the first backend start; until then the password is"
  echo "whatever MOCK_PASSWORD says in $ENV_FILE"
  exit 0
fi

PW="$PASSWORD" DB="$DB" bun -e '
const { Database } = require("bun:sqlite");
const db = new Database(process.env.DB);
const exists = db
  .query("select count(*) as n from settings where key = ?")
  .get("auth.password_hash");
if (!exists || exists.n === 0) {
  console.log("no password was stored in this database (nothing to reset)");
} else {
  db.run("delete from settings where key = ?", ["auth.password_hash"]);
  console.log("cleared the stored password hash");
}
db.close();
'

# Write the chosen value where the next boot reads its bootstrap credential, so
# a single restart lands on a password you know.
if [ -f "$ENV_FILE" ]; then
  tmp="$(mktemp)"
  if grep -qE '^MOCK_PASSWORD=' "$ENV_FILE"; then
    sed -E "s|^MOCK_PASSWORD=.*$|MOCK_PASSWORD=${PASSWORD}|" "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf 'MOCK_PASSWORD=%s\n' "$PASSWORD" >>"$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "set MOCK_PASSWORD in apps/web/.env to the value you will use"
fi

echo ""
echo "restart the backend, then log in with: user-001 / ${PASSWORD}"
