import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Transport } from '../../application/ports/transport'
import type { CliManifest, CliRuntimeContext } from '../cli-types'
import { parseArgv } from '../args/parse'
import { FLAG_SESSION, FLAG_OUTPUT_FORMAT } from '../args/common-flags'
import { readStdinIfPiped } from '../io/read-stdin'
import { Errors } from '../errors/cli-error'
import { UnixSocketTransport } from '../../infrastructure/transport/unix-socket-transport'
import { MAIN_SESSION_ID } from '../../domain/anchor'

// ── Types ──

export interface PrintOpts {
  socketPath: string
  sessionId: string
  prompt: string
  onAssistantText?: (chunk: string) => void
}

export interface PrintWithTransportOpts {
  transport: Transport
  sessionId: string
  prompt: string
  onAssistantText?: (chunk: string) => void
}

export interface PrintResult {
  text: string
  turnId: string
}

// ── Output format whitelist ──

const SUPPORTED_FORMATS = ['text'] as const

// ── Core: transport-level (testable with inmem, no filesystem) ──

export async function runPrintWithTransport(opts: PrintWithTransportOpts): Promise<PrintResult> {
  const writeText = opts.onAssistantText ?? ((s: string) => { process.stdout.write(s) })

  let text = ''
  let turnId = ''
  let failure: string | null = null

  const done = new Promise<void>((resolve) => {
    const unsub = opts.transport.onEvent((ev: { type: string; payload?: unknown }) => {
      if (ev.type === 'assistant.delta') {
        const delta = String((ev.payload as Record<string, unknown>)?.delta ?? '')
        text += delta
        writeText(delta)
      } else if (ev.type === 'turn.completed') {
        turnId = String((ev.payload as Record<string, unknown>)?.turnId ?? '')
        unsub()
        resolve()
      } else if (ev.type === 'turn.failed') {
        failure = String((ev.payload as Record<string, unknown>)?.error ?? 'Turn failed')
        unsub()
        resolve()
      }
    })
  })

  const attachResp = await opts.transport.sendRpc({
    jsonrpc: '2.0', id: 'attach', method: 'session.attach',
    params: { sessionId: opts.sessionId },
  })
  if (attachResp && 'error' in attachResp && attachResp.error) {
    throw Errors.rpcFailed('session.attach', attachResp.error)
  }

  const inputResp = await opts.transport.sendRpc({
    jsonrpc: '2.0', id: `input-${Date.now()}`, method: 'input.send',
    params: { sessionId: opts.sessionId, text: opts.prompt },
  })
  if (inputResp && 'error' in inputResp && inputResp.error) {
    throw Errors.rpcFailed('input.send', inputResp.error)
  }

  await done
  if (failure) throw Errors.turnFailed(failure)
  return { text, turnId }
}

// ── Mid layer: creates transport (testable with socket path, no ctx) ──

export async function runPrint(opts: PrintOpts): Promise<PrintResult> {
  if (!existsSync(opts.socketPath)) {
    const agentId = path.basename(path.dirname(opts.socketPath))
    throw Errors.daemonNotRunning(agentId, opts.socketPath)
  }

  const transport = new UnixSocketTransport(opts.socketPath)
  try {
    await transport.connect()
  } catch (err) {
    throw Errors.daemonConnectFailed(opts.socketPath, err)
  }

  try {
    return await runPrintWithTransport({
      transport,
      sessionId: opts.sessionId,
      prompt: opts.prompt,
      onAssistantText: opts.onAssistantText,
    })
  } finally {
    await transport.close().catch(() => { /* best-effort */ })
  }
}

// ── Handler: CLI entry point (ctx → opts assembly) ──

async function handlePrint(argv: string[], ctx: CliRuntimeContext): Promise<void> {
  const parsed = parseArgv(argv, [
    FLAG_SESSION,
    FLAG_OUTPUT_FORMAT,
    { name: 'no-stdin', type: 'boolean', default: false, description: 'Do not read stdin' },
    { name: 'stdin-timeout', type: 'string', default: '50', description: 'First-byte timeout in ms' },
  ], 'strict')

  // Validate output format before any I/O
  const format = String(parsed.flags['output-format'] ?? 'text')
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(format)) {
    throw Errors.unsupportedFormat(format, SUPPORTED_FORMATS as readonly string[])
  }

  const sessionId = String(parsed.flags.session ?? MAIN_SESSION_ID)
  const stdinTimeoutMs = Number(parsed.flags['stdin-timeout'])

  // Assemble prompt
  const stdinText = parsed.flags['no-stdin'] || stdinTimeoutMs === 0
    ? ''
    : await readStdinIfPiped({ firstByteTimeoutMs: stdinTimeoutMs })

  const promptArg = parsed.positional.join(' ')
  const prompt = [stdinText, promptArg].filter(Boolean).join('\n\n').trim()
  if (!prompt) throw Errors.missingPrompt()

  await runPrint({
    socketPath: ctx.socketPath,
    sessionId,
    prompt,
  })
  process.stdout.write('\n')
}

// ── Manifest ──

export const cliPrint: CliManifest = {
  name: 'print',
  description: 'Run a single-turn agent non-interactively (stdin/stdout)',
  usage: [
    'my-agent print [--session <id>] [--no-stdin] [--stdin-timeout=<ms>] "prompt"',
    '  Reads stdin until EOF if piped. If pipe never closes (e.g. tail -f),',
    '  use --no-stdin or bound input with head/tail.',
  ].join('\n'),
  needs: [],
  handler: handlePrint,
}
