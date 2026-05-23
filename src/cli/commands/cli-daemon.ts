import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHomePaths } from '../../infrastructure/paths/home-paths'
import { createAgentPaths } from '../../infrastructure/paths/agent-paths'
import type { CliManifest } from '../cli-types'

/* eslint-disable no-console -- CLI command output */

const DAEMON_READY_PROBE_MS = 2500

function getAgentArg(argv: string[]): string | null {
  const aIdx = argv.indexOf('-a')
  if (aIdx >= 0 && aIdx + 1 < argv.length) return argv[aIdx + 1] ?? null
  const agentIdx = argv.indexOf('--agent')
  if (agentIdx >= 0 && agentIdx + 1 < argv.length) return argv[agentIdx + 1] ?? null
  const pIdx = argv.indexOf('--profile')
  if (pIdx >= 0 && pIdx + 1 < argv.length) {
    console.warn('Warning: --profile is deprecated. Use --agent or -a instead.')
    return argv[pIdx + 1] ?? null
  }
  return null
}

async function daemonStart(argv: string[]): Promise<void> {
  const agentId = getAgentArg(argv) ?? 'default'
  const home = createHomePaths()
  const paths = createAgentPaths(home.agentsRoot, agentId)

  mkdirSync(paths.agentDir, { recursive: true })

  console.log(`Starting daemon for agent "${agentId}"...`)

  let daemonStderr = ''
  const proc = spawn('bun', ['run', 'bin/my-agent-daemon.ts', '--agent', agentId], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env },
    detached: true,
  })
  const onStderr = (chunk: Buffer) => { daemonStderr += chunk.toString() }
  proc.stderr?.on('data', onStderr)

  writeFileSync(join(paths.agentDir, 'daemon.pid'), String(proc.pid), 'utf-8')

  // Wait for socket or process exit, up to DAEMON_READY_PROBE_MS
  const started = await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      clearInterval(check)
      clearTimeout(timeout)
    }
    const check = setInterval(() => {
      if (existsSync(paths.socket)) { cleanup(); resolve(true); return }
      if (proc.exitCode !== null) { cleanup(); resolve(false); return }
    }, 100)
    const timeout = setTimeout(() => { cleanup(); resolve(false) }, DAEMON_READY_PROBE_MS)
  })

  // Always clean up to let the parent exit
  proc.stderr?.removeListener('data', onStderr)
  proc.stderr?.destroy()
  proc.unref()

  if (started) {
    console.log(`Daemon ready. Socket: ${paths.socket}`)
    console.log(`Daemon started (PID: ${proc.pid}). Use "my-agent session attach" to connect.`)
  } else if (proc.exitCode !== null) {
    if (existsSync(join(paths.agentDir, 'daemon.pid'))) {
      try { unlinkSync(join(paths.agentDir, 'daemon.pid')) } catch { /* ignore */ }
    }
    console.error(daemonStderr.trim() || `Daemon exited with code ${proc.exitCode}`)
    process.exit(proc.exitCode ?? 1)
  } else {
    console.log(`Daemon started (PID: ${proc.pid}). Socket may still be initializing.`)
    console.log('Check: ' + join(paths.logs, 'agent.log'))
  }
}

async function daemonStop(argv: string[]): Promise<void> {
  const agentId = getAgentArg(argv) ?? 'default'
  const home = createHomePaths()
  const paths = createAgentPaths(home.agentsRoot, agentId)
  const pidFile = join(paths.agentDir, 'daemon.pid')
  if (!existsSync(pidFile)) {
    console.log(`No PID file for "${agentId}" — daemon may not be running.`)
    return
  }
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`Daemon "${agentId}" stopped (PID ${pid}).`)
  } catch {
    console.log(`Failed to signal PID ${pid}. Already stopped?`)
  }
}

async function daemonList(): Promise<void> {
  const home = createHomePaths()
  if (!existsSync(home.agentsRoot)) { console.log('No agents found.'); return }
  const dirs = readdirSync(home.agentsRoot).filter(d => existsSync(join(home.agentsRoot, d, 'daemon.pid')))
  if (dirs.length === 0) { console.log('No running daemons.'); return }
  console.log('\nRunning daemons:\n')
  for (const d of dirs) {
    const pid = readFileSync(join(home.agentsRoot, d, 'daemon.pid'), 'utf-8').trim()
    const sock = existsSync(join(home.agentsRoot, d, 'daemon.sock')) ? 'connected' : 'no socket'
    console.log(`  ${d}  PID: ${pid}  [${sock}]`)
  }
  console.log('')
}

async function handleLogs(args: string[]): Promise<void> {
  const proc = spawn('bun', ['run', 'bin/my-agent-daemon.ts', 'logs', ...args], {
    stdio: 'inherit',
    env: { ...process.env },
  })
  proc.on('exit', (code) => process.exit(code ?? 0))
}

export const cliDaemon: CliManifest = {
  name: 'daemon',
  description: 'Manage daemon lifecycle',
  usage: 'my-agent daemon <start|stop|status|logs> -a <agent>',
  handler: async (argv, _ctx) => {
    const sub = argv[0] ?? ''
    switch (sub) {
      case 'start': {
        await daemonStart(argv)
        return
      }
      case 'stop': {
        await daemonStop(argv)
        return
      }
      case 'status':
      case 'list':
      case 'ls': {
        await daemonList()
        return
      }
      case 'logs': {
        await handleLogs(argv.slice(1))
        return
      }
      case undefined:
      default: {
        console.error('Usage: my-agent daemon <start|stop|status|logs> -a <agent>')
        process.exit(1)
      }
    }
  },
}

/* eslint-enable no-console */
