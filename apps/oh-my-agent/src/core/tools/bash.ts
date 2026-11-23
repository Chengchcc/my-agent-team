import { resolve as resolvePath } from "node:path";
import type { Tool } from "@chengchenccc/message";
import { childEnv } from "@chengchenccc/message";
import { type CoordinationRegistry, defaultRegistry } from "../coordination/registry.js";
import { ptyWrap, withPtyEnv } from "./bash-pty.js";
import type { BashSandbox } from "./bash-sandbox.js";
import { NullBashSandbox } from "./bash-sandbox.js";
import { readStringField } from "./presentation.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

let nextJobSeq = 1;

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this command is being run.",
};

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
/** Per-call ceiling for the model's `timeout` arg (also the runtime's
 *  wrapper backstop — the tool owns the deadline, the wrapper just catches a
 *  wedged process). */
export const MAX_BASH_TIMEOUT_MS = 600_000;

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

/** Backend-injected command tripwire: EXACT whole-string matches only.
 *
 *  Deliberately not a boundary and deliberately not clever: "git push; curl
 *  evil" is a different string, so this stops the command an agent runs
 *  verbatim (the accidental `git push`, the habitual destructive one), not a
 *  determined bypass. No prefix matching (a prefix rule is a bypass), no
 *  regex over command lines (quotes, expansions, base64 are all bypasses).
 *  Rules arrive by env for the same reason the path policy does: the workspace
 *  is agent-writable. */
export function deniedCommand(
  command: string,
  rulesRaw: string | undefined = process.env.OMA_DENY_COMMANDS,
): string | undefined {
  const rules = (rulesRaw ?? "")
    .split(",")
    .map((rule) => rule.trim())
    .filter((rule) => rule !== "");
  const trimmed = command.trim();
  return rules.find((rule) => rule === trimmed);
}

/** Write-side fence for the SHELL (ADR 0072 applied to bash).
 *
 *  `validateCwd` only guards the cwd PARAMETER; a command can `cd
 *  /root/my-agent-team && git checkout -b x` and write anywhere. Live
 *  2026-11-23 a worker did exactly that in the operator's real repository.
 *
 *  Deliberately narrow and honest about its ceiling: it looks at absolute
 *  paths in a command that also carries a write verb (or a redirect into that
 *  path) and refuses when one lands outside the workspace. Quotes, variables
 *  and `cd` chains can still defeat a textual scan — this is a guard against
 *  the accident, not a sandbox. The real boundary is OS isolation. */
const WRITE_VERB =
  /\b(?:rm|rmdir|mv|cp|tee|mkdir|touch|chmod|chown|dd|truncate|install|ln|sed\s+-i|git\s+(?:add|commit|checkout|switch|reset|clean|push|merge|rebase|stash|branch|tag))\b/;

export function writeEscapeOf(command: string, workspaceRoot: string): string | undefined {
  // A redirect is a write even when no verb is named ().
  if (!WRITE_VERB.test(command) && !command.includes(">")) return undefined;
  const root = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
  const absolute = [...command.matchAll(/(?:^|[\s;|&(])(\/[^\s;|&)"']+)/g)].map((m) => m[1]);
  for (const path of absolute) {
    if (path === undefined) continue;
    // `/dev/null` and the standard streams are not files the run writes:
    // `cmd 2>/dev/null` is read-only work, and refusing it made ordinary
    // commands look like escapes (live 2026-11-23 a worker could not inspect
    // a file because it redirected stderr).
    if (/^\/dev\/(null|stdout|stderr|tty)$/.test(path)) continue;
    if (path === workspaceRoot) return path;
    if (path.startsWith(root)) continue;
    // A denied absolute path that is only READ is fine; the write verb gate
    // above already scoped this to commands that change something.
    return path;
  }
  return undefined;
}

/** Paths this run may neither read nor write (backend-injected
 *  OMA_DENY_WRITE_PATHS). A denied path is a secret boundary, so a READ of it
 *  is not "harmless": live 2026-11-23 a worker read the backend's data
 *  directory (`.env` with provider keys, the whole SQLite database) with
 *  `cat`/`ls` — the write fence never looked at reads.
 *
 *  Textual, therefore leaky (`cd` chains, variables, `find -exec`); the hard
 *  boundary stays the OS sandbox. This catches the accident and the obvious
 *  attempt. */
export function deniedPathOf(
  command: string,
  workspaceRoot: string,
  denyRules: readonly string[],
): string | undefined {
  if (denyRules.length === 0) return undefined;
  const root = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
  const ws = resolvePath(workspaceRoot);
  const matches = (candidate: string): string | undefined => {
    let full = candidate;
    // `~` is the home directory, not a workspace-relative name: `cat
    // ~/.ssh/id_ed25519` must hit a `/root/.ssh/` rule (live 2026-11-23 the
    // scanner read it as `./~/.ssh/...` and allowed it).
    const home = process.env.HOME;
    if (candidate === "~" || candidate.startsWith("~/")) {
      if (home === undefined || home === "") return undefined;
      full = `${home}${candidate.slice(1)}`;
    } else if (!candidate.startsWith("/")) {
      full = `${root}${candidate}`;
    }
    const normalized = resolvePath(full);
    const insideWorkspace = normalized === ws || normalized.startsWith(`${ws}/`);
    for (const rule of denyRules) {
      const base = rule.endsWith("/") ? rule.slice(0, -1) : resolvePath(rule);
      const hit = normalized === base || normalized.startsWith(`${base}/`);
      if (!hit) continue;
      // The workspace is always readable — a worker's own directory sits INSIDE
      // the data directory, and denying the ancestor must not deny the worker.
      // A rule that points INSIDE the workspace (.env in it) still applies.
      if (insideWorkspace && !base.startsWith(`${ws}/`) && base !== ws) continue;
      return rule;
    }
    return undefined;
  };
  // Absolute tokens, and relative ones that walk up (`../x`) or name a denied
  // entry (`cat .backend-data/backend.db`).
  const tokens = [...command.matchAll(/(?:^|[\s;|&(='"])((?:\.\.?\/)?[^\s;|&)'"]+)/g)]
    .map((m) => m[1])
    .filter((t): t is string => t !== undefined);
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    if (!token.includes("/") && token !== ".." && !token.includes(".")) continue;
    const hit = matches(token);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The backend's deny list, one rule per entry (comma-separated in the env). */
function denyRulesOf(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Repository the run's workspace is nested inside, when it is not the
 *  workspace itself. A backend agent workspace lives under the operator's
 *  checkout (`<repo>/apps/backend/.backend-data/agents/<id>`), so `git` there
 *  addresses the OPERATOR's repository: live 2026-11-23 a worker ran plain git
 *  commands in it and staged/moved files in the real repo. A run may only talk
 *  to a repository it owns — its own project copy. */
/** Async on purpose: the TUI's event loop must never wait on a subprocess (its
 *  e2e suite pins that), and the tool table is assembled on that loop. */
export async function foreignRepoOf(workspaceRoot: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "-C", workspaceRoot, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) return undefined;
  const top = (await new Response(proc.stdout).text()).trim();
  if (top === "") return undefined;
  const ws = resolvePath(workspaceRoot);
  if (top === ws) return undefined;
  return top;
}

/** Refuse a git command aimed at a repository the run does not own. A command
 *  that first enters an owned directory (`cd projects/<id> && git …`) or names
 *  one with `-C <path>` is fine. Textual, like the other fences. */
export function foreignRepoRefusal(
  command: string,
  workspaceRoot: string,
  foreignTop: string | undefined,
): string | undefined {
  if (foreignTop === undefined) return undefined;
  if (!/\bgit\b/.test(command)) return undefined;
  const ws = resolvePath(workspaceRoot);
  const owned = (candidate: string): boolean => {
    if (!candidate.startsWith("/")) candidate = resolvePath(`${ws}/${candidate}`);
    const target = resolvePath(candidate);
    return target === ws || target.startsWith(`${ws}/`);
  };
  for (const m of command.matchAll(/\bgit\s+(?:-C\s+)?([^\s;&|]+)/g)) {
    const arg = m[1];
    if (arg === undefined) continue;
    if (arg === "-C") continue;
    if (arg.startsWith("-")) continue;
    // A bare word is a git subcommand ("status"), not a path: treating it as
    // workspace-relative made every command look owned.
    if (!arg.includes("/") && arg !== "." && arg !== "..") continue;
    if (owned(arg)) return undefined;
  }
  if (/\bcd\s+[^\s;&|]+\s*(?:&&|;)/.test(command)) {
    const cd = /\bcd\s+([^\s;&|]+)/.exec(command);
    const arg = cd?.[1];
    if (arg !== undefined && owned(arg)) return undefined;
  }
  return foreignTop;
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
    signal?: AbortSignal,
  ) => Promise<BashPtyResult>;
  /** Resolved runtime knobs (see resolveRuntimeKnobs): the tool never reads
   *  process.env, so a long-lived process cannot leak another Run's config. */
  timeouts?: { bashTimeoutMs?: number; maxToolTimeoutMs?: number };
  /** Background-job registry (default: the process-wide one). */
  registry?: CoordinationRegistry;
}): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);
  /** Resolved once: whether this workspace sits inside a repository it does
   *  not own (the backend's agent data directory sits inside the operator's
   *  checkout). */
  let foreignTopPromise: Promise<string | undefined> | undefined;
  const foreignTopOf = (): Promise<string | undefined> =>
    (foreignTopPromise ??= foreignRepoOf(opts.workspaceRoot).catch(() => undefined));
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
          output: job.truncated
            ? `${job.output}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`
            : job.output,
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
    // The command's first line is the most useful thing a remote surface can
    // show; safeToolSummary flattens it to one line, redacts credentials and
    // truncates, so this never leaks a key or a multi-line script.
    describeStart: (input) => {
      const command = readStringField(input, "command");
      return command
        ? { title: "运行命令", detail: command, icon: "command", visibility: "expandable" }
        : { title: "运行命令", icon: "command", visibility: "compact" };
    },
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
      // Command tripwire (allow-rules, command slice): exact whole-string
      // matches, injected by the backend, honoured regardless of yolo.
      const denied = deniedCommand(command);
      if (denied !== undefined) {
        return {
          content: `Error: command denied by OMA_DENY_COMMANDS: ${denied}`,
          isError: true,
        };
      }
      // Shell write fence (ADR 0072): a command that writes to an absolute
      // path outside the workspace is refused here, not audited later. Only
      // WITHOUT an OS sandbox: bwrap is the real boundary, and pre-empting it
      // makes the sandbox's own guarantees untestable.
      const escaped =
        opts.sandbox === undefined ? writeEscapeOf(command, opts.workspaceRoot) : undefined;
      if (escaped !== undefined) {
        return {
          content: `Error: writes outside the workspace are refused by this run (${escaped}). Work inside ${opts.workspaceRoot}.`,
          isError: true,
        };
      }
      // A repository the run does not own: plain git here addresses the
      // operator's checkout (an agent workspace is nested inside it).
      const foreign = foreignRepoRefusal(command, opts.workspaceRoot, await foreignTopOf());
      if (foreign !== undefined) {
        return {
          content: `Error: this workspace is not a git repository; ${foreign} is, and it is not yours. Work in your own copy (${opts.workspaceRoot}/projects/<projectId>) or pass -C <that path>.`,
          isError: true,
        };
      }
      // A denied path is denied for reading too: the backend's data directory
      // holds provider keys (.env) and the whole database.
      const deniedRule = deniedPathOf(
        command,
        opts.workspaceRoot,
        denyRulesOf(process.env.OMA_DENY_WRITE_PATHS),
      );
      if (deniedRule !== undefined) {
        return {
          content: `Error: path denied by this run's policy (${deniedRule}). It holds credentials or other runs' data; ask the person if you believe you need it.`,
          isError: true,
        };
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
      // needs tooling (PATH/HOME/LANG/TZ), not provider keys or injected
      // MCP bearers. Full inheritance let one `env`/`printenv` read every
      // secret the oma process holds, voiding the childEnv allowlist and
      // stderr redaction above it.
      const BASH_ENV_DENY = /API_KEY|AUTH_TOKEN|_TOKEN$|_SECRET$|PASSWORD|PASSWD/;
      const bashEnv: Record<string, string> = Object.fromEntries(
        Object.entries(childEnv(process.env)).filter(([k]) => !BASH_ENV_DENY.test(k)),
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
      //
      // NOT under an OS sandbox: the overlay spawns its own bare `bash -c`
      // (modes/tui/pty-console.ts), so delegating to it would silently void the
      // confinement the user opted into. A sandboxed Run falls through to the
      // launcher-spawned script-bridge pty below, which IS confined (it goes
      // through this same launcher).
      const ptyOverlay = pty && opts.ptyConsole !== undefined && opts.sandbox === undefined;
      if (pty && opts.ptyConsole !== undefined && opts.sandbox !== undefined) {
        notice = "pty overlay skipped: the OS sandbox is active, so it ran inside the sandbox";
      }
      if (ptyOverlay && opts.ptyConsole) {
        const done = await opts.ptyConsole(command, validatedCwd, withPtyEnv(bashEnv), signal);
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
      if (pty && !ptyOverlay) {
        const wrapped = ptyWrap(command);
        if (wrapped === null) {
          notice ||= "pty requested but unavailable in this environment; ran without a terminal";
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
