#!/usr/bin/env bun
import 'dotenv/config'
import { bootstrap, AgentNotFoundError } from '../src/interface/daemon/main'
import { parseArgs } from '../src/interface/daemon/parse-daemon-args'

const EXIT_AGENT_NOT_FOUND = 3

const opts = parseArgs(process.argv.slice(2))
let handle: Awaited<ReturnType<typeof bootstrap>>
try {
  handle = await bootstrap(opts)
  console.error(`[daemon] agent=${opts.agentId} socket=${handle.socketPath}`)
} catch (err) {
  if (err instanceof AgentNotFoundError) {
    console.error(`Agent '${opts.agentId}' not found.`)
    console.error('Create it first: my-agent agent create')
    console.error('Or let it seed as default: my-agent daemon start')
    process.exit(EXIT_AGENT_NOT_FOUND)
  }
  throw err
}

const shutdown = async (sig: string) => {
  console.error(`[daemon] received ${sig}, stopping...`)
  await handle?.stop()
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown('SIGTERM').catch(() => {}) })
process.on('SIGINT', () => { void shutdown('SIGINT').catch(() => {}) })
