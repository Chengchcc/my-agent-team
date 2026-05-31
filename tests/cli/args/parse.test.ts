import { describe, it, expect } from 'bun:test'
import { parseArgv, UnknownFlagError, MissingFlagError } from '../../../src/cli/args/parse'
import type { FlagSpec } from '../../../src/cli/args/parse'

const STRING_FLAG: FlagSpec = { name: 'agent', alias: 'a', type: 'string', default: 'default', description: '' }
const BOOL_FLAG: FlagSpec = { name: 'verbose', alias: 'v', type: 'boolean', default: false, description: '' }

describe('parseArgv', () => {
  it('collects positionals when no flags match', () => {
    const result = parseArgv(['hello', 'world'], [])
    expect(result.positional).toEqual(['hello', 'world'])
    expect(result.flags).toEqual({})
  })

  it('parses --name value', () => {
    const result = parseArgv(['--agent', 'foo'], [STRING_FLAG])
    expect(result.flags.agent).toBe('foo')
  })

  it('parses --name=value', () => {
    const result = parseArgv(['--agent=foo'], [STRING_FLAG])
    expect(result.flags.agent).toBe('foo')
  })

  it('parses -a value', () => {
    const result = parseArgv(['-a', 'foo'], [STRING_FLAG])
    expect(result.flags.agent).toBe('foo')
  })

  it('parses --verbose as true', () => {
    const result = parseArgv(['--verbose'], [BOOL_FLAG])
    expect(result.flags.verbose).toBe(true)
  })

  it('parses --no-verbose as false', () => {
    const result = parseArgv(['--no-verbose'], [BOOL_FLAG])
    expect(result.flags.verbose).toBe(false)
  })

  it('applies default values for unspecified flags', () => {
    const result = parseArgv([], [STRING_FLAG, BOOL_FLAG])
    expect(result.flags.agent).toBe('default')
    expect(result.flags.verbose).toBe(false)
  })

  it('stops flag parsing after --', () => {
    const result = parseArgv(['--', '--agent', 'foo'], [STRING_FLAG])
    expect(result.positional).toEqual(['--agent', 'foo'])
    expect(result.flags.agent).toBe('default')
  })

  it('sets flags.help for --help', () => {
    const result = parseArgv(['--help'], [])
    expect(result.flags.help).toBe(true)
  })

  it('sets flags.help for -h', () => {
    const result = parseArgv(['-h'], [])
    expect(result.flags.help).toBe(true)
  })

  it('throws UnknownFlagError for unknown long flag in strict mode', () => {
    expect(() => parseArgv(['--unknown'], [STRING_FLAG], 'strict')).toThrow(UnknownFlagError)
  })

  it('throws MissingFlagError when string flag has no value', () => {
    expect(() => parseArgv(['--agent'], [STRING_FLAG], 'strict')).toThrow(MissingFlagError)
  })

  it('preserves unknown flag + value in positionals (permissive)', () => {
    const result = parseArgv(['--unknown', 'val'], [STRING_FLAG], 'permissive')
    expect(result.positional).toEqual(['--unknown', 'val'])
  })

  it('preserves unknown flag with = in positionals (permissive)', () => {
    const result = parseArgv(['--unknown=val'], [STRING_FLAG], 'permissive')
    expect(result.positional).toEqual(['--unknown=val'])
  })

  it('keeps value that matches flag name as positional (G16 regression)', () => {
    const result = parseArgv(['--agent', 'default', 'default'], [STRING_FLAG])
    expect(result.flags.agent).toBe('default')
    expect(result.positional).toEqual(['default'])
  })

  it('handles global flag before subcommand', () => {
    const result = parseArgv(['--agent', 'foo', 'print', 'hello'], [STRING_FLAG])
    expect(result.flags.agent).toBe('foo')
    expect(result.positional).toEqual(['print', 'hello'])
  })
})
