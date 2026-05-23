import type { CliManifest } from '../cli-types'

async function handleLogs(args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process')
  const proc = spawn('bun', ['run', 'bin/my-agent-daemon.ts', 'logs', ...args], {
    stdio: 'inherit',
    env: { ...process.env },
  })
  proc.on('exit', (code) => process.exit(code ?? 0))
}

export const cliLogs: CliManifest = {
  name: 'logs',
  description: 'View daemon logs',
  usage: 'my-agent logs [args]',
  handler: async (argv, _ctx) => {
    await handleLogs(argv)
  },
}
