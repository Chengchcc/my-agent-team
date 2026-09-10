import { childEnv } from "@chengchenccc/agent-contract";
import type { Tool } from "@chengchenccc/message";
import { type CoordinationRegistry, defaultRegistry } from "../coordination/registry.js";
import { ptyWrap, withPtyEnv } from "./bash-pty.js";
import type { BashSandbox } from "./bash-sandbox.js";
import { NullBashSandbox } from "./bash-sandbox.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

let nextJobSeq = 1;

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this command is being run.",
};

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const MAX_BASH_TIMEOUT_MS = 600_000;

/** M10: cap captured output — a runaway `yes` must OOM neither the child
 *  nor this process. Streams to onOutput keep flowing; accumulation stops. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

async function cappedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total <= MAX_OUTPUT_BYTES) out += decoder.decode(value, { stream: true });
  }
  return total > MAX_OUTPUT_BYTES ? `${out}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : out;
}

interface BashJob {
  id: string;
  command: string;
  proc: { kill(): void; exited: Promise<number | null> };
  output: string;
  truncated: boolean;
  bytes: number;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  settleResolve: () => void;
}

export interface BashPtyResult {
  exitCode: number | null;
  /** Last captured output tail (capped) for the model summary. */
  tail: string;
  killed: boolean;
}

export function createBashTool(opts: {
  workspaceRoot: string;
  /** Coordination scope: TUI session key or backend run id. */
  scope: string;
  /** Launch strategy; default Null = current unconstrained behavior. */
  sandbox?: BashSandbox;
  /** M-bash: interactive pty runner (TUI console overlay). When present,
   *  pty:true delegates here instead of the headless script capture. */
  ptyConsole?: (
    command: string,
    cwd: string,
    env: Record<string, string>,
  ) => Promise<BashPtyResult>;
  /** Resolved runtime knobs (see resolveRuntimeKnobs): the tool never reads
   *  process.env, so a long-lived process cannot leak another Run's config. */
  timeouts?: { bashTimeoutMs?: number; maxToolTimeoutMs?: number };
  /** Background-job registry (default: the process-wide one). */
  registry?: CoordinationRegistry;
}): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);
  const launcher = opts.sandbox ?? new NullBashSandbox(opts.workspaceRoot);
  const scope = opts.scope;
  const registry = opts.registry ?? defaultRegistry;
  const defaultTimeoutMs = opts.timeouts?.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const maxTimeoutMs = opts.timeouts?.maxToolTimeoutMs ?? 0;

  function startJob(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): BashJob {
    const id = `bg_${nextJobSeq++}`;
    const proc = launcher.spawn(command, { cwd, env });
    const job: BashJob = {
      id,
      command,
      proc,
      output: "",
      truncated: false,
      bytes: 0,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      timedOut: false,
      killed: false,
      timer: null,
      settleResolve: () => {},
    };
    const kill = (): void => {
      job.killed = true;
      // BashSpawn.kill is SIGKILL-first and covers the process group.
      proc.kill();
    };
    const { promise: settle, resolve: resolveSettle } = Promise.withResolvers<void>();
    const reg = registry.registerEntry({
      id,
      kind: "bash",
      scope,
      label: command,
      startedAt: job.startedAt,
      status: "running",
      finishedAt: null,
      partialText: "",
      settle,
      resolveSettle,
      kill,
    });
    if (!reg.ok) {
      proc.kill();
      throw new Error(reg.error);
    }
    const pump = (stream: ReadableStream<Uint8Array>) => {
      void (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          job.bytes += value.byteLength;
          if (job.bytes <= MAX_OUTPUT_BYTES) job.output += chunk;
          else job.truncated = true;
          registry.appendEntryPartial(id, chunk);
        }
      })();
    };
    pump(proc.stdout);
    pump(proc.stderr);
    if (timeoutMs > 0) {
      job.timer = setTimeout(() => {
        job.timedOut = true;
        kill();
      }, timeoutMs);
    }
    void proc.exited
      .then((code) => {
        job.exitCode = code;
        job.finishedAt = Date.now();
        if (job.timer) clearTimeout(job.timer);
        const settled = code === 0 && !job.timedOut && !job.killed;
        registry.settleEntry(id, {
          status: settled ? "completed" : "failed",
          exitCode: code,
          timedOut: job.timedOut,
          killed: job.killed,
          output: job.output.slice(-2000),
          isError: code !== 0 || job.timedOut,
        });
      })
      .catch(() => {
        job.finishedAt = Date.now();
        if (job.timer) clearTimeout(job.timer);
        registry.settleEntry(id, { status: "failed" });
      });
    return job;
  }

  return {
    name: "bash",
    description:
      "Execute a bash shell command. Returns exit code, stdout, and stderr. Default timeout 30s, max 600s. " +
      "Supports background execution (async): returns a job id immediately; collect with the hub tool " +
      "(output/wait/stop). Also supports pseudo-terminal mode (pty) for commands that need a real TTY.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        async: {
          type: "boolean",
          description:
            "Run in the background: returns a job id immediately. Collect output with the hub tool " +
            "(output/wait); the job keeps running until its timeout.",
        },
        pty: {
          type: "boolean",
          description:
            "Run under a pseudo-terminal (for commands that need a real TTY: colors, progress bars, " +
            "TUI programs). Ignored when async is true. Falls back with a notice when no pty tool exists.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 30000, max 600000)",
        },
        cwd: {
          type: "string",
          description: "Working directory (relative to workspace root)",
        },
      },
      required: ["description", "command"],
    },
    async execute(input, signal?: AbortSignal, options?: { onOutput?: (s: string) => void }) {
      const {
        command,
        timeout = defaultTimeoutMs,
        cwd,
        pty = false,
      } = input as {
        command: string;
        timeout?: number;
        cwd?: string;
        pty?: boolean;
      };

      const upper = maxTimeoutMs;
      const cap = upper > 0 ? Math.min(upper, MAX_BASH_TIMEOUT_MS) : MAX_BASH_TIMEOUT_MS;
      const clamped = Math.min(Math.max(timeout, 1), cap);

      if (!command) {
        return { content: "Error: command is required", isError: true };
      }
      // Validate cwd against the fixed workspace sandbox. Out-of-bounds cwd
      // is a tool error, never a silent fallback to process cwd.
      let validatedCwd = opts.workspaceRoot;
      if (cwd) {
        try {
          validatedCwd = sandbox.validateCwd(cwd);
        } catch {
          return {
            content: `Error: cwd escapes workspace root: ${cwd}`,
            isError: true,
          };
        }
      }
      // Strip credential-shaped vars from the inherited env: the bash child
      // needs tooling (PATH/HOME/LANG/TZ), not provider keys or the per-run
      // product-tools token. Full inheritance let one `env`/`printenv` read
      // every secret the oma process holds, voiding the childEnv allowlist
      // and stderr redaction above it.
      const BASH_ENV_DENY = /API_KEY|AUTH_TOKEN|_TOKEN$|_SECRET$|PASSWORD|PASSWD/;
      const bashEnv: Record<string, string> = Object.fromEntries(
        Object.entries(childEnv()).filter(([k]) => !BASH_ENV_DENY.test(k)),
      );
      let notice = "";
      let effectiveCommand = command;

      // Background execution (M-bash): register in the coordination registry
      // and return a job id immediately. Runs BEFORE pty handling (pi
      // ordering: async wins, jobs stay headless).
      if ((input as { async?: boolean }).async === true) {
        let job: BashJob;
        try {
          job = startJob(effectiveCommand, validatedCwd, bashEnv, clamped);
        } catch (err) {
          return {
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        return {
          content: `Backgrounded as job ${job.id}; collect with hub { "op": "output", "id": "${job.id}" } or hub { "op": "wait", "ids": ["${job.id}"] }.`,
        };
      }

      // Interactive pty (M-bash): when a TUI console runner is injected,
      // pty:true hands the command to the overlay (user-interactive).
      if (pty && opts.ptyConsole) {
        const done = await opts.ptyConsole(command, validatedCwd, withPtyEnv(bashEnv));
        const tail = done.tail.trim();
        const failed = !done.killed && done.exitCode !== null && done.exitCode !== 0;
        const flag = done.killed
          ? " (killed)"
          : failed
            ? ` — Command exited with code ${done.exitCode}`
            : "";
        return {
          content: `${tail}${tail ? "\n" : ""}pty session finished (exit: ${done.exitCode ?? "signal"})${flag}`,
          isError: failed,
        };
      }
      if (pty) {
        const wrapped = ptyWrap(command);
        if (wrapped === null) {
          notice = "pty requested but unavailable in this environment; ran without a terminal";
        } else {
          effectiveCommand = wrapped;
          Object.assign(bashEnv, withPtyEnv({}));
        }
      }
      const proc = launcher.spawn(effectiveCommand, { cwd: validatedCwd, env: bashEnv });

      // Kill the process group on timeout OR abort signal.
      const killGroup = () => proc.kill();
      const timer = setTimeout(killGroup, clamped);
      const onAbort = () => killGroup();
      if (signal?.aborted) killGroup();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const stderrPromise = cappedText(proc.stderr);
        let stdout = "";
        if (options?.onOutput) {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            total += value.byteLength;
            if (total <= MAX_OUTPUT_BYTES) {
              stdout += chunk;
              options.onOutput(chunk);
            }
          }
          if (total > MAX_OUTPUT_BYTES) {
            stdout += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
          }
        } else {
          stdout = await cappedText(proc.stdout);
        }
        const stderr = await stderrPromise;
        const exitCode = await proc.exited;
        const noticeLine = notice ? `\n${notice}` : "";
        return {
          content: `${stdout}\n[exit: ${exitCode}]${stderr ? `\n${stderr}` : ""}${noticeLine}`,
          isError: exitCode !== 0,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
