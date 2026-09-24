/** Spawn the pi CLI. Same shape as adapter-oma-agent's process helper
 *  (LF-framed stdout lines, bounded stderr tail) but no secrets redaction —
 *  pi has no token-bearing env vars of its own. */

import { childEnv, collectSecrets, redactText } from "@chengchenccc/agent-contract";
import type { Subprocess } from "bun";

export interface PiCommandConfig {
  executable: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

export interface SpawnedPiProcess {
  readonly pid: number;
  /** Strict LF-framed stdout lines (JSONL). */
  readonly stdout: AsyncIterable<string>;
  /** Bounded stderr tail (last 64 KiB) for crash diagnostics. */
  readonly stderrTail: string;
  /** Resolves with the child's exit code (null when killed by signal). */
  readonly exit: Promise<number | null>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

/** Grace period between the direct child's exit and force-closing stdout:
 *  terminal lines written just before exit get to drain, then a grandchild
 *  holding the pipe can no longer stall the consumer. */
export const ORPHAN_PIPE_GRACE_MS = 5_000;

/** Strict LF-framed line reader (only \n splits frames; byte-buffered for
 *  half packets; bounded frame size). */
async function* readLines(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
  orphanGraceMs: number,
): AsyncIterable<string> {
  // M12: the buffer is trimmed to its last MAX_FRAME bytes after every
  // chunk — a line-less flood (no \n) previously grew the heap unbounded.
  const MAX_FRAME = 10 * 1024 * 1024;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  // A grandchild that inherits the stdout pipe (the CLI's own tool
  // subprocesses) keeps it open after the direct child dies; the consumer's
  // loop would then wait forever and the run would never settle. Race every
  // read against the child's exit plus a drain grace — when the grace wins,
  // stop reading. (reader.cancel() exists but segfaults Bun 1.3.14 here.)
  const orphanDeadline = exited.then(() => Bun.sleep(orphanGraceMs));
  try {
    for (;;) {
      const step = await Promise.race([
        reader.read().then((r) => ({ kind: "read" as const, r })),
        orphanDeadline.then(() => ({ kind: "orphan" as const })),
      ]);
      if (step.kind === "orphan") break;
      const { done, value } = step.r;
      if (done) break;
      if (value.length === 0) continue;
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer, 0);
      next.set(value, buffer.length);
      buffer = next;
      if (buffer.length > MAX_FRAME) buffer = buffer.slice(buffer.length - MAX_FRAME);
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== 0x0a) continue;
        if (i - start <= MAX_FRAME) yield decoder.decode(buffer.subarray(start, i));
        start = i + 1;
      }
      buffer = buffer.slice(start);
    }
    if (buffer.length > 0 && buffer.length <= MAX_FRAME) yield decoder.decode(buffer);
  } finally {
    reader.releaseLock();
  }
}

export function spawnPiProcess(
  cfg: PiCommandConfig,
  opts: { cwd: string; orphanGraceMs?: number },
): SpawnedPiProcess {
  let stderrTail = "";
  // Secrets captured from the child env: a crashed CLI echoing its
  // environment must never leak keys into the persistent tail.
  const secrets = collectSecrets(cfg.env ?? {});
  // Allowlisted env only: parent OMP_DAEMON_* handles never reach the child
  // (they would route the pi worker at the wrong daemon and hang the run).
  const env = childEnv(cfg.env);
  const proc: Subprocess = Bun.spawn({
    cmd: [cfg.executable, ...(cfg.args ?? [])],
    cwd: opts.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrTail = redactText((stderrTail + decoder.decode(value)).slice(-64 * 1024), secrets);
    }
  })();

  return {
    pid: proc.pid,
    stdout: readLines(
      proc.stdout as ReadableStream<Uint8Array>,
      proc.exited,
      opts.orphanGraceMs ?? ORPHAN_PIPE_GRACE_MS,
    ),
    get stderrTail() {
      return stderrTail;
    },
    exit: proc.exited,
    kill: (signal) => proc.kill(signal),
  };
}
