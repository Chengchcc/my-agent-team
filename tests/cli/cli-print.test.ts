import { describe, it, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrint } from '../../src/cli/commands/cli-print'
import { CliError } from '../../src/cli/errors/cli-error'

describe('runPrint', () => {
  it('throws E_DAEMON_NOT_RUNNING when socket does not exist', async () => {
    const nonexistentSocket = join(tmpdir(), `nonexistent-${Date.now()}.sock`)
    const err = await runPrint({
      socketPath: nonexistentSocket,
      sessionId: 'main',
      prompt: 'hello',
    }).catch(e => e)

    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).code).toBe('E_DAEMON_NOT_RUNNING')
    expect((err as CliError).exitCode).toBe(1)
    expect((err as CliError).hint).toContain('daemon start')
  })
})
