import * as clack from '@clack/prompts'
import chalk from 'chalk'

export interface Prompts {
  intro(title: string): void
  outro(message: string): void
  text(opts: { message: string; defaultValue?: string; validate?(value: string | undefined): string | Error | undefined }): Promise<string>
  password(opts: { message: string }): Promise<string>
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>
  select(opts: { message: string; options: Array<{ value: string; label: string; hint?: string }> }): Promise<string>
  multiselect(opts: { message: string; options: Array<{ value: string; label: string }> }): Promise<string[]>
  multiline(opts: { message: string; terminator?: string }): Promise<string>
  withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T>
  cancel(message?: string): never
  fail(message: string, hint?: string): never
}

export function createPrompts(): Prompts {
  return {
    intro(title: string): void {
      clack.intro(chalk.cyan(title))
    },

    outro(message: string): void {
      clack.outro(chalk.green(message))
    },

    async text(opts): Promise<string> {
      const result = await clack.text({
        message: opts.message,
        defaultValue: opts.defaultValue,
        validate: opts.validate,
      })
      if (clack.isCancel(result)) {
        clack.cancel(chalk.red('Cancelled'))
        process.exit(0)
      }
      return result as string
    },

    async password(opts): Promise<string> {
      const result = await clack.password({ message: opts.message })
      if (clack.isCancel(result)) {
        clack.cancel(chalk.red('Cancelled'))
        process.exit(0)
      }
      return result as string
    },

    async confirm(opts): Promise<boolean> {
      const result = await clack.confirm({
        message: opts.message,
        initialValue: opts.initialValue ?? false,
      })
      if (clack.isCancel(result)) {
        clack.cancel(chalk.red('Cancelled'))
        process.exit(0)
      }
      return result as boolean
    },

    async select(opts): Promise<string> {
      const result = await clack.select({
        message: opts.message,
        options: opts.options.map(o => ({ value: o.value, label: o.label, hint: o.hint })),
      })
      if (clack.isCancel(result)) {
        clack.cancel(chalk.red('Cancelled'))
        process.exit(0)
      }
      return result as string
    },

    async multiselect(opts): Promise<string[]> {
      const result = await clack.multiselect({
        message: opts.message,
        options: opts.options.map(o => ({ value: o.value, label: o.label })),
      })
      if (clack.isCancel(result)) {
        clack.cancel(chalk.red('Cancelled'))
        process.exit(0)
      }
      return result as string[]
    },

    async multiline(opts): Promise<string> {
      // clack doesn't have built-in multiline — use text with instruction
      const result = await clack.text({
        message: `${opts.message}\n${chalk.gray(`(empty line or '${opts.terminator ?? '.'}' to finish)`)}`,
      })
      if (clack.isCancel(result)) {
        clack.cancel(chalk.red('Cancelled'))
        process.exit(0)
      }
      return result as string
    },

    async withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const spinner = clack.spinner()
      spinner.start(label)
      try {
        const result = await fn()
        spinner.stop(chalk.green('Done'))
        return result
      } catch (err) {
        spinner.stop(chalk.red('Failed'))
        throw err
      }
    },

    cancel(message?: string): never {
      clack.cancel(chalk.red(message ?? 'Cancelled'))
      process.exit(0)
    },

    fail(message: string, hint?: string): never {
      clack.cancel(chalk.red('\u2716 ' + message))
      if (hint) process.stderr.write(chalk.gray('  ' + hint) + '\n')
      process.exit(2)
    },
  }
}

/** Wrap a flow function: catches throws inside clack scope, restores terminal, re-throws for main.ts. */
export async function runWithPromptGuard<T>(_prompts: Prompts, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    clack.cancel('')
    throw err
  }
}
