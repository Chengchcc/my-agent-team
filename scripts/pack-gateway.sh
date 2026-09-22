#!/usr/bin/env bash
# pack-gateway.sh — build the shippable oma gateway artifact (backend + web).
#
# This is the single source of truth for the artifact layout, used by both
# .github/workflows/artifact-probe.yml (verify it boots) and publish.yml
# (attach it to the tag's release). Two copies of this logic would drift.
#
# Layout inside the tarball:
#   gateway.json                 — manifest oma reads (components/ports/runtime)
#   backend/main.js            — backend bundled to one platform-independent file
#   backend/drizzle/backend/   — drizzle migrations (a bundled entry cannot
#                                resolve the source-relative path, so the
#                                manifest points BACKEND_MIGRATIONS_DIR here)
#   web/                       — Next standalone tree root (node_modules, ...)
#   web/apps/web/server.js     — the entry (monorepo: mirrors the tracing root)
#   web/apps/web/public/monaco/vs — self-hosted editor assets (gitignored, so
#                                they are NOT in a checkout and must be added)
#
# Usage: bash scripts/pack-gateway.sh [--version V] [--out DIR]
#        Run it AFTER `bun run build`: the backend bundle inlines workspace
#        packages from their dist/ output, so a stale dist ships stale behaviour.
# Env:   STACK_ROOT — repo root override (test seam; defaults to this script's ..)

set -euo pipefail

ROOT="${STACK_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
VERSION=""
OUT="$ROOT/dist-gateway"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --out=*) OUT="${1#*=}"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "pack-gateway: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
fi

WEB="$ROOT/apps/web"
die() { echo "pack-gateway: FAIL — $*" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ── backend: one file + migrations + the child MCP entry ──────────
echo "pack-gateway: bundling backend"
( cd "$ROOT" && bun build apps/backend/src/main.ts --target=bun --outfile="$STAGE/backend/main.js" )
# Spawned per agent workspace as `bun <entry>` (process.execPath + args), so it
# needs its own bundle; the manifest points KNOWLEDGE_MCP_SERVER_BIN at it.
( cd "$ROOT" && bun build apps/backend/src/features/knowledge/mcp-server.ts --target=bun --outfile="$STAGE/backend/knowledge-mcp.js" )
mkdir -p "$STAGE/backend/drizzle"
cp -r "$ROOT/apps/backend/drizzle/." "$STAGE/backend/drizzle/"

# ── resources: the seeds the backend reads at runtime ─────────────
# These are repo-relative paths in source (skills/, docs/, the workflow
# showcase). A bundle cannot resolve them, so they ship next to it and
# BACKEND_RESOURCES_DIR points at this directory.
echo "pack-gateway: staging resources"
mkdir -p "$STAGE/resources/workflow-showcase"
cp -r "$ROOT/skills/." "$STAGE/resources/skills/"
cp -r "$ROOT/docs/." "$STAGE/resources/docs/"  # builtin knowledge pack source (pack name: architecture)
cp -r "$ROOT/apps/backend/src/features/workflow/showcase/." "$STAGE/resources/workflow-showcase/"

# ── web: standalone tree + static + self-hosted monaco ────────────
echo "pack-gateway: assembling web payload"
STANDALONE="$(find "$WEB/.next" -maxdepth 6 -type d -name standalone -print -quit 2>/dev/null || true)"
[ -n "$STANDALONE" ] || die "no .next/standalone — build web with output: standalone first"
SERVER="$(find "$STANDALONE" -maxdepth 5 -name server.js -print -quit)"
[ -n "$SERVER" ] || die "no server.js under $STANDALONE"
APPDIR="$(dirname "$SERVER")"
APPREL="${APPDIR#"$STANDALONE"/}"
echo "pack-gateway: standalone entry = $APPREL/server.js"

mkdir -p "$STAGE/web"
cp -r "$STANDALONE/." "$STAGE/web/"
mkdir -p "$STAGE/web/$APPREL/.next"
cp -r "$WEB/.next/static" "$STAGE/web/$APPREL/.next/static"
if [ -d "$WEB/public" ]; then
  mkdir -p "$STAGE/web/$APPREL/public"
  cp -r "$WEB/public/." "$STAGE/web/$APPREL/public/"
fi
MONACO=""
for c in "$WEB/node_modules/monaco-editor/min/vs" "$ROOT/node_modules/monaco-editor/min/vs"; do
  [ -f "$c/loader.js" ] && MONACO="$c" && break
done
[ -n "$MONACO" ] || die "monaco-editor/min/vs not found (bun install first)"
mkdir -p "$STAGE/web/$APPREL/public/monaco"
cp -r "$MONACO" "$STAGE/web/$APPREL/public/monaco/vs"

# ── manifest (the contract oma consumes) ──────────────────────────
cat > "$STAGE/gateway.json" <<JSON
{
  "schemaVersion": 1,
  "name": "my-agent-team",
  "version": "$VERSION",
  "components": [
    {
      "name": "backend",
      "runtime": "bun",
      "cwd": "backend",
      "entry": "main.js",
      "port": 3000,
      "healthUrl": "http://127.0.0.1:3000/health",
      "env": {
        "BACKEND_DATA_DIR": "{dataDir}/backend",
        "MOCK_PASSWORD": "{secret:MOCK_PASSWORD}",
        "BACKEND_MIGRATIONS_DIR": "{root}/backend/drizzle/backend",
        "BACKEND_RESOURCES_DIR": "{root}/resources",
        "BACKEND_HOST": "127.0.0.1",
        "BACKEND_PORT": "3000",
        "KNOWLEDGE_MCP_SERVER_BIN": "{root}/backend/knowledge-mcp.js",
        "OMA_BIN": "{omaBin}"
      },
      "secrets": ["BACKEND_AUTH_TOKEN"]
    },
    {
      "name": "web",
      "runtime": "bun",
      "cwd": "web/$APPREL",
      "entry": "server.js",
      "port": 3001,
      "healthUrl": "http://127.0.0.1:3001/login",
      "env": {
        "BACKEND_URL": "http://127.0.0.1:3000",
        "BACKEND_AUTH_TOKEN": "{secret:BACKEND_AUTH_TOKEN}",
        "SESSION_SECRET": "{secret:SESSION_SECRET}",
        "MOCK_USER_ID": "user-001",
        "MOCK_PASSWORD": "{secret:MOCK_PASSWORD}",
        "PORT": "3001",
        "HOSTNAME": "127.0.0.1"
      },
      "dependsOn": ["backend"]
    }
  ]
}
JSON

# ── fail-closed checks ────────────────────────────────────────────
echo "pack-gateway: checks"
[ -s "$STAGE/backend/main.js" ] || die "backend bundle is empty"
[ -s "$STAGE/backend/knowledge-mcp.js" ] || die "knowledge MCP bundle missing"
[ -f "$STAGE/backend/drizzle/backend/meta/_journal.json" ] || die "migrations journal missing"
[ -d "$STAGE/resources/skills" ] || die "resources/skills missing"
[ -d "$STAGE/resources/docs" ] || die "resources/docs missing"
[ -f "$STAGE/web/$APPREL/public/monaco/vs/loader.js" ] || die "monaco assets missing"
[ -d "$STAGE/web/$APPREL/.next/server" ] || die "app server code missing"

NATIVE="$(find "$STAGE" \( -name '*.node' -o -name '*.so*' \) -print -quit)"
[ -z "$NATIVE" ] || die "platform-specific native leaked in: $NATIVE"

CACHE="$(find "$STAGE" -maxdepth 6 -type d -name cache -path '*/.next/*' -print -quit)"
[ -z "$CACHE" ] || die "build cache leaked in: $CACHE"

bun -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$STAGE/gateway.json" \
  || die "gateway.json is not valid JSON"
echo "pack-gateway: ok — no natives, no build cache, manifest valid"

# ── package ───────────────────────────────────────────────────────
mkdir -p "$OUT"
TAR="$OUT/oma-gateway-$VERSION.tar.zst"
tar --zstd -cf "$TAR" -C "$STAGE" .
( cd "$OUT" && sha256sum "$(basename "$TAR")" > SHA256SUMS )

RAW=$(du -sb "$STAGE" | cut -f1)
PACKED=$(stat -c %s "$TAR")
echo "pack-gateway: $TAR — $(numfmt --to=iec "$RAW") raw -> $(numfmt --to=iec "$PACKED") packed"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## oma gateway artifact $VERSION"
    echo
    echo "| part | size |"
    echo "|---|---|"
    echo "| backend bundle | $(du -sh "$STAGE/backend/main.js" | cut -f1) |"
    echo "| backend resources (skills/docs/showcase) | $(du -sh "$STAGE/resources" | cut -f1) |"
    echo "| web payload | $(du -sh "$STAGE/web" | cut -f1) |"
    echo "| — monaco assets | $(du -sh "$STAGE/web/$APPREL/public/monaco" | cut -f1) |"
    echo "| total raw | $(numfmt --to=iec "$RAW") |"
    echo "| tar.zst | $(numfmt --to=iec "$PACKED") |"
    echo "| sha256 | \`$(cut -d' ' -f1 "$OUT/SHA256SUMS")\` |"
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "pack-gateway: done"
