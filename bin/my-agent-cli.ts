#!/usr/bin/env bun
// bin/my-agent-cli.ts
// Thin CLI entry point — see src/cli/ for resource handlers

import { main } from '../src/cli/main';

main(process.argv.slice(2)).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
