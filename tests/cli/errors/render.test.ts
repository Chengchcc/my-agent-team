import { describe, it, expect } from 'bun:test'
import { renderCliError } from '../../../src/cli/errors/render'
import { CliError, Errors } from '../../../src/cli/errors/cli-error'

function stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*m/g, '') }

describe('renderCliError', () => {
  it('renders friendly CliError without stack', () => {
    const err = Errors.daemonNotRunning('test', '/tmp/test.sock')
    const { stderr } = renderCliError(err, { verbose: false })
    expect(stripAnsi(stderr)).toContain('Daemon not running')
    expect(stripAnsi(stderr)).not.toContain('[E_DAEMON_NOT_RUNNING]')
    expect(stripAnsi(stderr)).not.toContain('Stack:')
  })

  it('renders verbose CliError with code and stack', () => {
    const err = Errors.daemonNotRunning('test', '/tmp/test.sock')
    const { stderr } = renderCliError(err, { verbose: true })
    expect(stripAnsi(stderr)).toContain('[E_DAEMON_NOT_RUNNING]')
    expect(stripAnsi(stderr)).toContain('/tmp/test.sock')
    expect(stripAnsi(stderr)).toContain('Stack:')
  })

  it('renders unknown Error with generic message', () => {
    const err = new Error('something broke')
    const { stderr } = renderCliError(err, { verbose: false })
    expect(stripAnsi(stderr)).toContain('something broke')
    expect(stripAnsi(stderr)).toContain('--verbose')
  })

  it('returns exitCode from CliError', () => {
    const err = Errors.unknownCommand('foo')
    const { exitCode } = renderCliError(err, { verbose: false })
    expect(exitCode).toBe(2)
  })

  it('returns exitCode 1 for unknown errors', () => {
    const { exitCode } = renderCliError('raw string', { verbose: false })
    expect(exitCode).toBe(1)
  })

  it.each([
    ['daemonNotRunning', Errors.daemonNotRunning('x', '/s'), 'E_DAEMON_NOT_RUNNING', 1],
    ['agentNotFound', Errors.agentNotFound('x'), 'E_AGENT_NOT_FOUND', 2],
    ['unknownCommand', Errors.unknownCommand('x'), 'E_UNKNOWN_COMMAND', 2],
    ['missingPrompt', Errors.missingPrompt(), 'E_MISSING_PROMPT', 2],
    ['turnFailed', Errors.turnFailed('boom'), 'E_TURN_FAILED', 1],
    ['stdinTooLarge', Errors.stdinTooLarge(11_000_000, 10_485_760), 'E_STDIN_TOO_LARGE', 2],
    ['unsupportedFormat', Errors.unsupportedFormat('yaml', ['text']), 'E_UNSUPPORTED_FORMAT', 2],
  ])('%s has correct code and exitCode', (_name, err, code, exitCode) => {
    expect(err.code).toBe(code)
    expect(err.exitCode).toBe(exitCode)
  })
})
