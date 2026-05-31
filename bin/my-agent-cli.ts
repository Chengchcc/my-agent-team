#!/usr/bin/env bun
// bin/my-agent-cli.ts
// Thin CLI entry point — see src/cli/ for resource handlers

import { main } from '../src/cli/main'
import { renderCliError } from '../src/cli/errors/render'

main(process.argv.slice(2)).catch((err) => {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v')
    || process.argv.includes('--debug') || !!process.env.MY_AGENT_DEBUG
  const { stderr, exitCode } = renderCliError(err, { verbose })
  process.stderr.write(stderr + '\n')
  process.exit(exitCode)
})
