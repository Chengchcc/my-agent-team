#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Generate drizzle migration files for all databases.
# Migration files ARE committed (not gitignored). This script regenerates
# them and checks for uncommitted diffs - if schema.ts changed but
# migrations weren't regenerated, CI fails.

cd apps/backend
bunx drizzle-kit generate --config drizzle.backend.config.ts

cd ../../packages/framework
bunx drizzle-kit generate

cd ../../apps/lark-bot
bunx drizzle-kit generate

cd "$(dirname "$0")/.."

# Check for uncommitted changes in drizzle directories
if [ -n "$(git status --porcelain drizzle/ apps/*/drizzle/ packages/*/drizzle/ 2>/dev/null)" ]; then
  echo "ERROR: drizzle migration files are out of date."
  echo "Schema changed but migrations were not regenerated."
  echo "Run 'bash scripts/gen-drizzle.sh' locally and commit the changes."
  git status --porcelain drizzle/ apps/*/drizzle/ packages/*/drizzle/ 2>/dev/null
  exit 1
fi

echo "All drizzle migrations are up to date."
