/** Shared PTY helpers for bash-tool pty mode and the TUI pty console. */

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
/** Wrap a command so it runs with a real pseudo-terminal (script -e keeps
 *  the exit code). util-linux (Linux) and BSD script (macOS) differ:
 *  util-linux takes ONE shell string via -c; BSD script execs
 *  `command args...` argv-style — a quoted shell string is taken as the
 *  NAME of a binary ("echo hi" does not exist), so the command must ride
 *  through `bash -c` explicitly.
 *  Returns null when no script binary exists. */
export function ptyWrap(
  command: string,
  opts?: { platform?: string; scriptPath?: string | null },
): string | null {
  const platform = opts?.platform ?? process.platform;
  // Explicit null means "no script binary" (the fallback test); only an
  // ABSENT scriptPath resolves through PATH.
  const script = opts?.scriptPath === undefined ? Bun.which("script") : opts.scriptPath;
  if (!script) return null;
  if (platform === "darwin") {
    return `${script} -q /dev/null bash -c ${shellQuote(command)}`;
  }
  return `${script} -qec ${shellQuote(command)} /dev/null`;
}

/** script-bridge pty with a fixed window size: stty runs INSIDE the pty
 *  before the command, sizing it for TUI programs (no live resize). */
export function ptyConsoleCommand(
  command: string,
  cols: number,
  rows: number,
  opts?: { platform?: string; scriptPath?: string | null },
): string | null {
  const wrapped = ptyWrap(command, opts);
  if (wrapped === null) return null;
  return `stty rows ${rows} cols ${cols}; ${wrapped}`;
}

/** Extra env a pty child needs (the plain bash env has no TERM). */
export function withPtyEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, TERM: "xterm-256color" };
}
