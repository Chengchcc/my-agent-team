import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { canSandbox } from "@chengchenccc/sandbox";

export interface ScriptAgentOptions {
  readonly role?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly label?: string;
  readonly timeoutMs?: number;
}

export interface OrchestrationPrimitives {
  readonly agent: (prompt: string, opts?: ScriptAgentOptions) => Promise<unknown>;
  /** Deterministic read-only workspace tool bridge (glob, grep, read, ls, tree). */
  readonly tool?: (name: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Legacy unused field retained as optional for test/caller compatibility. */
  readonly pipeline?: (
    items: readonly unknown[],
    fn: (item: unknown) => Promise<unknown>,
    opts?: { concurrency?: number },
  ) => Promise<readonly unknown[]>;
  readonly onPhase?: (phase: {
    name: string;
    status: "started" | "completed" | "failed";
    durationMs?: number;
  }) => void;
  readonly onLog?: (message: string) => void;
}

export interface EvaluateResult {
  readonly value: unknown;
  readonly logs: readonly string[];
}

/** Default overall wall-clock cap for multi-stage orchestration scripts (30 min).
 *  Sync CPU spins are still capped separately by `SYNC_EVAL_TIMEOUT_MS` inside
 *  the worker's `vm.runInContext`, so infinite loops die quickly while real
 *  multi-agent pipelines can run to completion. */
export const DEFAULT_ORCHESTRATION_TIMEOUT_MS = 30 * 60_000;
const SYNC_EVAL_TIMEOUT_MS = 30_000;
const MAX_LOGS = 200;
const MAX_LOG_CHARS = 500;
const IPC_PREFIX = "__OMA_ORCH_IPC__:";

/** Child-process worker harness: runs the orchestration script in a separate OS
 *  process with minimal env (no host secrets, no host JS object references).
 *  Inside the worker, `vm.createContext` with `codeGeneration: { strings: false,
 *  wasm: false }` strips `process`/`require`/`Bun`/`fetch`; `agent()` and
 *  `tool()` send JSON-RPC calls over stdout and await host replies on stdin.
 *  If a script spins synchronously or in a microtask (`await Promise.resolve();
 *  while(true){}`), the host kills the child process group without freezing
 *  the host event loop. */
const WORKER_SCRIPT = `
import vm from "node:vm";
import readline from "node:readline";

const IPC = ${JSON.stringify(IPC_PREFIX)};
const pending = new Map();
let nextId = 1;

function send(msg) {
  process.stdout.write(IPC + JSON.stringify(msg) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initPayload = null;
let startResolve = null;
const started = new Promise((r) => { startResolve = r; });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "init") {
    initPayload = msg;
    startResolve?.();
    return;
  }
  if (msg.type === "rpc_res") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.value);
    else entry.reject(new Error(msg.error || "orchestration call failed"));
  }
});

await started;
const { script, args, syncTimeoutMs } = initPayload;

function formatLogArg(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Create context with clean sandbox-local functions so even prototype walking
// cannot touch host-realm secrets (the child itself runs with stripped env and
// optional bwrap isolation).
const context = vm.createContext(
  {
    __callAgent: (prompt, optsJson) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        let opts;
        if (typeof optsJson === "string" && optsJson.length > 0) {
          try { opts = JSON.parse(optsJson); } catch { opts = undefined; }
        }
        send({ type: "agent_req", id, prompt: String(prompt), opts });
      });
    },
    __callTool: (name, inputJson) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        let input = {};
        if (typeof inputJson === "string" && inputJson.length > 0) {
          try {
            const parsed = JSON.parse(inputJson);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
          } catch { input = {}; }
        }
        send({ type: "tool_req", id, name: String(name), input });
      });
    },
    __emitPhase: (name, status, durationMs) => {
      send({ type: "phase", name: String(name), status: String(status), durationMs });
    },
    __emitLog: (message) => {
      send({ type: "log", message: String(message) });
    },
    __formatLogArg: formatLogArg,
    __argsJson: JSON.stringify(args === undefined ? null : args),
    __hasArgs: args !== undefined,
  },
  { name: "orchestrate-script", codeGeneration: { strings: false, wasm: false } },
);

const prelude = \`
const args = __hasArgs ? JSON.parse(__argsJson) : undefined;
const agent = (prompt, opts) => __callAgent(prompt, opts === undefined ? "" : JSON.stringify(opts));
const tool = (name, input) => __callTool(name, input === undefined ? "{}" : JSON.stringify(input));
const log = (...parts) => __emitLog(parts.map(__formatLogArg).join(" "));
const console = Object.freeze({
  log,
  info: log,
  warn: (...parts) => log("[warn]", ...parts),
  error: (...parts) => log("[error]", ...parts),
});
const phase = async (name, fn) => {
  const startedAt = Date.now();
  __emitPhase(name, "started");
  try {
    const out = await fn();
    __emitPhase(name, "completed", Date.now() - startedAt);
    return out;
  } catch (err) {
    __emitPhase(name, "failed", Date.now() - startedAt);
    throw err;
  }
};
const parallel = async (items, fn, opts) => {
  const arr = Array.from(items);
  const conc = opts && typeof opts.concurrency === "number" && opts.concurrency > 0
    ? Math.floor(opts.concurrency)
    : arr.length || 1;
  if (conc >= arr.length) return Promise.all(arr.map((item, idx) => fn(item, idx)));
  const out = new Array(arr.length);
  let idx = 0;
  async function worker() {
    while (idx < arr.length) {
      const cur = idx++;
      out[cur] = await fn(arr[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, arr.length) }, () => worker()));
  return out;
};
const pipeline = parallel;
\`;

const wrapped = \`(async () => { \${prelude} \${script} })()\`;
try {
  const promise = vm.runInContext(wrapped, context, { timeout: syncTimeoutMs });
  const value = await promise;
  send({ type: "done", ok: true, value: value === undefined ? null : value, hasValue: value !== undefined });
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  send({ type: "done", ok: false, error: message });
  process.exit(0);
}
`;

function buildWorkerArgv(): string[] {
  const base = [process.execPath, "-e", WORKER_SCRIPT];
  const hasSetsid = Bun.which("setsid") !== null;
  let argv = base;
  if (process.platform === "linux" && canSandbox()) {
    const binDir = dirname(process.execPath);
    argv = [
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--unshare-net",
      "--tmpfs",
      "/root",
      "--tmpfs",
      "/home",
      "--ro-bind",
      binDir,
      binDir,
      "--die-with-parent",
      ...base,
    ];
  }
  return hasSetsid ? ["setsid", ...argv] : argv;
}

function killWorkerTree(proc: ReturnType<typeof Bun.spawn>): void {
  const pid = proc.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* no process group — fall back to direct child kill */
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}

/** Isolated subprocess script evaluation: executes untrusted orchestration JS
 *  in a separate OS process with minimal env (plus bwrap when available) and
 *  bridges `agent()` / `tool()` calls over NDJSON stdio IPC. Eliminates
 *  host-realm VM escape (`agent.constructor.constructor`) and microtask
 *  event-loop freezes. */
export async function evaluateOrchestrationScript(input: {
  readonly script: string;
  readonly args?: unknown;
  readonly primitives: OrchestrationPrimitives;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<EvaluateResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ORCHESTRATION_TIMEOUT_MS;
  const syncTimeoutMs = Math.min(timeoutMs, SYNC_EVAL_TIMEOUT_MS);
  if (input.signal?.aborted) {
    throw new Error("orchestration script aborted");
  }

  const proc = Bun.spawn(buildWorkerArgv(), {
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: tmpdir(),
      LANG: process.env.LANG ?? "en_US.UTF-8",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const writeLine = (obj: unknown): void => {
    try {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* child already closed stdin */
    }
  };

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stderrText = "";
  const logs: string[] = [];

  const drainStderr = (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stderrText.length < 4096) stderrText += decoder.decode(value, { stream: true });
      }
    } catch {
      /* ignore */
    } finally {
      reader.releaseLock();
    }
  })();

  return await new Promise<EvaluateResult>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = (): void => {
      killWorkerTree(proc);
      finish(() => reject(new Error("orchestration script aborted")));
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      killWorkerTree(proc);
      finish(() => reject(new Error("orchestration script timed out")));
    }, timeoutMs);
    timer.unref?.();

    const handleIpc = (raw: string): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "agent_req") {
        const id = msg.id;
        const prompt = typeof msg.prompt === "string" ? msg.prompt : String(msg.prompt ?? "");
        const opts =
          msg.opts && typeof msg.opts === "object" && !Array.isArray(msg.opts)
            ? (msg.opts as ScriptAgentOptions)
            : undefined;
        void input.primitives
          .agent(prompt, opts)
          .then((value) => {
            if (!settled) writeLine({ type: "rpc_res", id, ok: true, value });
          })
          .catch((err: unknown) => {
            if (!settled) {
              writeLine({
                type: "rpc_res",
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
        return;
      }
      if (msg.type === "tool_req") {
        const id = msg.id;
        const name = typeof msg.name === "string" ? msg.name : String(msg.name ?? "");
        const toolInput =
          msg.input && typeof msg.input === "object" && !Array.isArray(msg.input)
            ? (msg.input as Readonly<Record<string, unknown>>)
            : {};
        if (!input.primitives.tool) {
          if (!settled) {
            writeLine({
              type: "rpc_res",
              id,
              ok: false,
              error: `tool("${name}") is unavailable in this orchestration context`,
            });
          }
          return;
        }
        void input.primitives
          .tool(name, toolInput)
          .then((value) => {
            if (!settled) writeLine({ type: "rpc_res", id, ok: true, value });
          })
          .catch((err: unknown) => {
            if (!settled) {
              writeLine({
                type: "rpc_res",
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
        return;
      }
      if (msg.type === "phase") {
        const name = typeof msg.name === "string" ? msg.name : "";
        const status = msg.status;
        if (name && (status === "started" || status === "completed" || status === "failed")) {
          const durationMs = typeof msg.durationMs === "number" ? msg.durationMs : undefined;
          input.primitives.onPhase?.({
            name,
            status,
            ...(durationMs !== undefined ? { durationMs } : {}),
          });
        }
        return;
      }
      if (msg.type === "log") {
        const line = String(msg.message ?? "").slice(0, MAX_LOG_CHARS);
        if (logs.length < MAX_LOGS) logs.push(line);
        input.primitives.onLog?.(line);
        return;
      }
      if (msg.type === "done") {
        killWorkerTree(proc);
        if (msg.ok) {
          finish(() => resolve({ value: msg.hasValue ? msg.value : undefined, logs }));
        } else {
          finish(() => reject(new Error(String(msg.error ?? "orchestration script failed"))));
        }
      }
    };

    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (;;) {
            const nl = buf.indexOf("\n");
            if (nl === -1) break;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith(IPC_PREFIX)) {
              handleIpc(line.slice(IPC_PREFIX.length));
            }
          }
        }
      } catch {
        /* killed or closed */
      } finally {
        reader.releaseLock();
      }
      const code = await proc.exited;
      await drainStderr;
      if (!settled) {
        const detail = stderrText.trim();
        finish(() =>
          reject(
            new Error(
              detail
                ? `orchestration script failed (exit ${code}): ${detail}`
                : `orchestration script exited unexpectedly (exit ${code})`,
            ),
          ),
        );
      }
    })();

    writeLine({
      type: "init",
      script: input.script,
      args: input.args,
      syncTimeoutMs,
    });
  });
}
