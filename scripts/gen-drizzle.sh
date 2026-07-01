#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Generate drizzle migration files for all 3 databases (S1: events.db merged into backend.db)
# These are gitignored — each developer runs this once locally.

cd apps/backend
bunx drizzle-kit generate --config drizzle.backend.config.ts

cd ../../packages/framework
bunx drizzle-kit generate

cd ../../apps/lark-bot
bunx drizzle-kit generate

echo "All done. drizzle/ directories are gitignored, do not commit."
