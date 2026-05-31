export type ParseMode = 'permissive' | 'strict'

export interface FlagSpec {
  readonly name: string
  readonly alias?: string
  readonly type: 'string' | 'boolean'
  readonly default?: string | boolean
  readonly required?: boolean
  readonly description: string
}

export interface ParsedArgs {
  /** Non-flag tokens, in order. First element is typically the subcommand name. */
  readonly positional: string[]
  /** Parsed flag values. Keys are flag names (long form). */
  readonly flags: Record<string, string | boolean>
  /** Original argv, for diagnostics. */
  readonly raw: string[]
}

export class UnknownFlagError extends Error {
  constructor(
    public readonly flag: string,
    public readonly supported: readonly string[],
  ) {
    super(`Unknown flag: ${flag}. Supported: ${supported.join(', ')}`)
  }
}

export class MissingFlagError extends Error {
  constructor(
    public readonly flag: string,
  ) {
    super(`Missing required value for flag: ${flag}`)
  }
}

const HELP_TOKENS = new Set(['--help', '-h'])
const NO_PREFIX = '--no-'
const NO_PREFIX_LEN = NO_PREFIX.length

function buildSpecMaps(specs: FlagSpec[]) {
  const byName = new Map<string, FlagSpec>()
  const byAlias = new Map<string, FlagSpec>()
  for (const spec of specs) {
    byName.set(spec.name, spec)
    if (spec.alias) byAlias.set(spec.alias, spec)
  }
  return { byName, byAlias }
}

function setDefaults(flags: Record<string, string | boolean>, specs: FlagSpec[]) {
  for (const spec of specs) {
    if (spec.default !== undefined) {
      flags[spec.name] = spec.default
    }
  }
}

interface ParseState {
  positional: string[]
  flags: Record<string, string | boolean>
  mode: ParseMode
  argv: string[]
  byName: Map<string, FlagSpec>
  byAlias: Map<string, FlagSpec>
  i: number
  ended: boolean
}

function handleLongFlag(state: ParseState, token: string): void {
  const eqIdx = token.indexOf('=')
  const name = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx)
  const spec = state.byName.get(name)

  if (!spec) {
    if (state.mode === 'strict') {
      throw new UnknownFlagError(`--${name}`, [...state.byName.keys()])
    }
    state.positional.push(token)
    if (eqIdx === -1 && state.i + 1 < state.argv.length && !state.argv[state.i + 1]!.startsWith('-')) {
      state.i++
      state.positional.push(state.argv[state.i]!)
    }
    return
  }

  if (spec.type === 'boolean') {
    if (eqIdx !== -1) {
      const val = token.slice(eqIdx + 1)
      state.flags[spec.name] = val === 'true' || val === '1'
    } else {
      state.flags[spec.name] = true
    }
    return
  }

  // string flag
  if (eqIdx !== -1) {
    state.flags[spec.name] = token.slice(eqIdx + 1)
    return
  }
  state.i++
  if (state.i >= state.argv.length || state.argv[state.i]!.startsWith('-')) {
    throw new MissingFlagError(spec.name)
  }
  state.flags[spec.name] = state.argv[state.i]!
}

function handleShortFlag(state: ParseState, token: string): void {
  const alias = token[1]!
  const spec = state.byAlias.get(alias)

  if (!spec) {
    if (state.mode === 'strict') {
      throw new UnknownFlagError(`-${alias}`, [...state.byAlias.keys()].map(a => `-${a}`))
    }
    state.positional.push(token)
    if (state.i + 1 < state.argv.length && !state.argv[state.i + 1]!.startsWith('-')) {
      state.i++
      state.positional.push(state.argv[state.i]!)
    }
    return
  }

  if (spec.type === 'boolean') {
    state.flags[spec.name] = true
    return
  }

  // string flag
  state.i++
  if (state.i >= state.argv.length || state.argv[state.i]!.startsWith('-')) {
    throw new MissingFlagError(spec.name)
  }
  state.flags[spec.name] = state.argv[state.i]!
}

function handleNegateFlag(state: ParseState, token: string): void {
  const name = token.slice(NO_PREFIX_LEN)
  const spec = state.byName.get(name)
  if (spec && spec.type === 'boolean') {
    state.flags[spec.name] = false
    return
  }
  if (state.mode === 'strict') {
    throw new UnknownFlagError(`--no-${name}`, [...state.byName.keys()])
  }
  state.positional.push(token)
}

/**
 * Parse argv against a flag schema.
 *
 * --help / -h are built-in reserved words: they always set flags.help = true
 * and are never treated as unknown flags or positional arguments.
 *
 * In 'permissive' mode, unknown long flags and their values are preserved
 * verbatim in the positional array so a downstream strict parse can handle them.
 * In 'strict' mode, unknown long flags throw UnknownFlagError.
 */
export function parseArgv(
  argv: string[],
  specs: FlagSpec[],
  mode: ParseMode = 'strict',
): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  setDefaults(flags, specs)
  const { byName, byAlias } = buildSpecMaps(specs)

  const state: ParseState = { positional: [], flags, mode, argv, byName, byAlias, i: 0, ended: false }

  while (state.i < argv.length) {
    const token = argv[state.i]!

    if (token === '--') { state.ended = true; state.i++; continue }
    if (state.ended) { state.positional.push(token); state.i++; continue }
    if (HELP_TOKENS.has(token)) { flags.help = true; state.i++; continue }

    if (token.startsWith('--')) {
      handleLongFlag(state, token)
    } else if (token.startsWith('-') && token.length === 2 && token[1] !== '-') {
      handleShortFlag(state, token)
    } else if (token.startsWith(NO_PREFIX)) {
      handleNegateFlag(state, token)
    } else {
      state.positional.push(token)
    }
    state.i++
  }

  return { positional: state.positional, flags: state.flags, raw: argv }
}
