/** Typed CLI error with stable code, optional hint, and verbose details. */
export class CliError extends Error {
  readonly code: string
  readonly hint?: string
  readonly details?: unknown
  readonly exitCode: number
  override readonly cause?: unknown

  constructor(opts: {
    code: string
    message: string
    hint?: string
    details?: unknown
    exitCode?: number
    cause?: unknown
  }) {
    super(opts.message)
    this.code = opts.code
    this.hint = opts.hint
    this.details = opts.details
    this.exitCode = opts.exitCode ?? 1
    this.cause = opts.cause
  }
}

function isPermissionError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'EACCES'
}

function isNoSpaceError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'ENOSPC'
}

function isSqliteCorrupt(e: unknown): boolean {
  const msg = String(e)
  return msg.includes('SQLITE_CORRUPT') || msg.includes('database disk image is malformed')
}

/** Sugar constructors — one per common failure mode. */
export const Errors = {
  daemonNotRunning: (agentId: string, socketPath: string) =>
    new CliError({
      code: 'E_DAEMON_NOT_RUNNING',
      message: `Daemon not running for agent "${agentId}".`,
      hint: `Start it first:  my-agent daemon start --agent ${agentId}`,
      details: `socketPath: ${socketPath}\nexists: false`,
      exitCode: 1,
    }),

  daemonConnectFailed: (socketPath: string, cause: unknown) =>
    new CliError({
      code: 'E_DAEMON_CONNECT_FAILED',
      message: 'Failed to connect to daemon.',
      hint: 'Check daemon status:  my-agent daemon status',
      details: `socketPath: ${socketPath}\ncause: ${String(cause)}`,
      exitCode: 1,
      cause,
    }),

  agentNotFound: (agentId: string) =>
    new CliError({
      code: 'E_AGENT_NOT_FOUND',
      message: `Agent "${agentId}" not found.`,
      hint: 'List agents:  my-agent agent list',
      exitCode: 2,
    }),

  sessionNotFound: (sessionId: string) =>
    new CliError({
      code: 'E_SESSION_NOT_FOUND',
      message: `Session "${sessionId}" not found.`,
      hint: 'List sessions:  my-agent session list',
      exitCode: 2,
    }),

  unknownCommand: (name: string) =>
    new CliError({
      code: 'E_UNKNOWN_COMMAND',
      message: `Unknown command "${name}".`,
      hint: 'Run  my-agent --help  for available commands.',
      exitCode: 2,
    }),

  unknownFlag: (flag: string, supported: readonly string[]) =>
    new CliError({
      code: 'E_UNKNOWN_FLAG',
      message: `Unknown flag: ${flag}.`,
      hint: `Supported flags: ${supported.join(', ')}`,
      exitCode: 2,
    }),

  missingFlag: (flag: string) =>
    new CliError({
      code: 'E_MISSING_FLAG',
      message: `Missing required value for flag: --${flag}.`,
      hint: `Usage: --${flag}=<value> or --${flag} <value>`,
      exitCode: 2,
    }),

  missingPrompt: () =>
    new CliError({
      code: 'E_MISSING_PROMPT',
      message: 'No prompt provided.',
      hint: 'Usage: my-agent print "your prompt"  (or pipe stdin)',
      exitCode: 2,
    }),

  rpcFailed: (method: string, cause: unknown) =>
    new CliError({
      code: 'E_RPC_FAILED',
      message: `RPC call "${method}" failed.`,
      details: String(cause),
      exitCode: 1,
      cause,
    }),

  turnFailed: (reason: string) =>
    new CliError({
      code: 'E_TURN_FAILED',
      message: 'Turn failed.',
      details: reason,
      exitCode: 1,
    }),

  unsupportedFormat: (got: string, supported: readonly string[]) =>
    new CliError({
      code: 'E_UNSUPPORTED_FORMAT',
      message: `Output format "${got}" is not supported.`,
      hint: `Supported formats: ${supported.join(', ')}`,
      exitCode: 2,
    }),

  stdinTooLarge: (bytes: number, cap: number) =>
    new CliError({
      code: 'E_STDIN_TOO_LARGE',
      message: `Stdin input exceeds ${cap / 1024 / 1024}MB limit (${(bytes / 1024 / 1024).toFixed(1)}MB received).`,
      hint: `Trim input: head -c ${cap} | my-agent print ...`,
      exitCode: 2,
    }),

  fsInitFailed: (path: string, cause: unknown) =>
    new CliError({
      code: 'E_FS_INIT',
      message: 'Could not prepare agent storage directory.',
      hint: isPermissionError(cause)
        ? `Permission denied. Check ownership of: ${path}`
        : isNoSpaceError(cause)
          ? `Disk full. Free space on the volume containing: ${path}`
          : `Set MY_AGENT_HOME to a writable directory, or check: ${path}`,
      details: `Path: ${path}\nCause: ${String(cause)}`,
      exitCode: 2,
      cause,
    }),

  registryInitFailed: (dbPath: string, cause: unknown) =>
    new CliError({
      code: 'E_REGISTRY_INIT',
      message: 'Could not open the agent registry database.',
      hint: isSqliteCorrupt(cause)
        ? `Database may be corrupted. Back up and remove: ${dbPath}`
        : `Check that ${dbPath} is writable and on a healthy volume.`,
      details: `DB: ${dbPath}\nCause: ${String(cause)}`,
      exitCode: 2,
      cause,
    }),

  flagMissingValue: (flag: string) =>
    new CliError({
      code: 'E_FLAG_MISSING_VALUE',
      message: `Flag --${flag} requires a value.`,
      hint: `Usage: --${flag}=<value> or --${flag} <value>`,
      exitCode: 2,
    }),
}
