import chalk from 'chalk'
import { CliError } from './cli-error'

interface RenderOpts {
  /** Whether to include stack traces and cause chains. */
  verbose: boolean
}

interface RenderResult {
  stderr: string
  exitCode: number
}

function renderCliErrorTyped(err: CliError, opts: RenderOpts): RenderResult {
  const lines: string[] = []

  if (opts.verbose) {
    lines.push(chalk.red(`\u2716  [${err.code}] ${err.message}`))
  } else {
    lines.push(chalk.red(`\u2716  ${err.message}`))
  }

  if (err.hint) {
    lines.push('')
    for (const line of err.hint.split('\n')) {
      lines.push(chalk.gray(`   \u203a  ${line.trim()}`))
    }
  }

  if (opts.verbose) {
    if (err.details !== undefined) {
      lines.push('')
      const detailsStr = typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2)
      for (const line of detailsStr.split('\n')) {
        lines.push(chalk.gray(`   ${line}`))
      }
    }
    if (err.stack) {
      lines.push('')
      lines.push('   Stack:')
      const stackLines = err.stack.split('\n').slice(1)
      for (const line of stackLines) {
        lines.push(chalk.gray(`   ${line}`))
      }
    }
    let cause = err.cause
    while (cause) {
      lines.push('')
      lines.push(chalk.gray(`   Caused by: ${cause instanceof Error ? cause.message : String(cause)}`))
      cause = (cause as Error)?.cause
    }
  }

  return { stderr: lines.join('\n'), exitCode: err.exitCode }
}

/**
 * Render a CLI error for display on stderr.
 *
 * CliError → friendly layout (cross-mark + message + hints)
 * Unknown Error → generic friendly + "run with --verbose"
 * Verbose mode → append [CODE] prefix, details block, stack, cause chain.
 */
export function renderCliError(err: unknown, opts: RenderOpts): RenderResult {
  if (err instanceof CliError) {
    return renderCliErrorTyped(err, opts)
  }

  const msg = err instanceof Error ? err.message : String(err)
  const lines = [chalk.red(`\u2716  Unexpected error: ${msg}`)]

  if (opts.verbose) {
    if (err instanceof Error && err.stack) {
      lines.push('')
      lines.push(chalk.gray(err.stack))
    }
    let cause = (err as Error)?.cause
    while (cause) {
      lines.push(chalk.gray(`Caused by: ${cause instanceof Error ? cause.message : String(cause)}`))
      cause = (cause as Error)?.cause
    }
  } else {
    lines.push('')
    lines.push(chalk.gray('  Run with --verbose for technical details.'))
  }

  return { stderr: lines.join('\n'), exitCode: 1 }
}
