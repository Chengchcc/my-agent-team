import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { canSandbox } from "@chengchenccc/sandbox";

export interface OrchestrationPrimitives {
  readonly agent: (
    prompt: string,
    opts?: { schema?: Readonly<Record<string, unknown>>; label?: string },
  ) => Promise<unknown>;
  readonly pipeline: (
    items: readonly unknown[],
    fn: (item: unknown) => Promise<unknown>,
    opts?: { concurrency?: number },
  ) => Promise<readonly unknown[]>;
}

export interface EvaluateResult {
  readonly value: unknown;
}

const IPC_PREFIX = "__OMA_ORCH_IPC__:";

/** Child-process worker harness: runs the orchestration script in a separate OS
 *  process with minimal env (no host secrets, no host JS object references).
 *  Inside the worker, `vm.createContext` with `codeGeneration: { strings: false,
 *  wasm: false }` strips `process`/`require`/`Bun`/`fetch`; `agent()` sends a
 *  JSON-RPC call over stdout and awaits the host's reply on stdin. If a script
 *  spins synchronously or in a microtask (`await Promise.resolve(); while(true){}`),
 *  the host kills the child process group without freezing the host event loop. */
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
  if (msg.type === "agent_res") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.value);
    else entry.reject(new Error(msg.error || "agent call failed"));
  }
});

await started;
const { script, args, timeoutMs } = initPayload;

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
    __argsJson: JSON.stringify(args === undefined ? null : args),
    __hasArgs: args !== undefined,
  },
  { name: "workflow-script", codeGeneration: { strings: false, wasm: false } },
);

const prelude = \`
const args = __hasArgs ? JSON.parse(__argsJson) : undefined;
const agent = (prompt, opts) => __callAgent(prompt, opts === undefined ? "" : JSON.stringify(opts));
const pipeline = async (items, fn, opts) => {
  const arr = Array.from(items);
  const conc = opts && typeof opts.concurrency === "number" && opts.concurrency > 0
    ? Math.floor(opts.concurrency)
    : arr.length || 1;
  if (conc >= arr.length) return Promise.all(arr.map(fn));
  const out = new Array(arr.length);
  let idx = 0;
  async function worker() {
    while (idx < arr.length) {
      const cur = idx++;
      out[cur] = await fn(arr[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, arr.length) }, () => worker()));
  return out;
};
\`;

const wrapped = \`(async () => { \${prelude} \${script} })()\`;
try {
  const promise = vm.runInContext(wrapped, context, { timeout: timeoutMs });
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
 *  bridges `agent()` calls over NDJSON stdio IPC. Eliminates host-realm VM
 *  escape (`agent.constructor.constructor`) and microtask event-loop freezes. */
export async function evaluateOrchestrationScript(input: {
  readonly script: string;
  readonly args?: unknown;
  readonly primitives: OrchestrationPrimitives;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<EvaluateResult> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (input.signal?.aborted) {
    throw new Error("workflow script aborted");
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
      finish(() => reject(new Error("workflow script aborted")));
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      killWorkerTree(proc);
      finish(() => reject(new Error("workflow script timed out")));
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
          msg.opts && typeof msg.opts === "object"
            ? (msg.opts as { schema?: Readonly<Record<string, unknown>>; label?: string })
            : undefined;
        void input.primitives
          .agent(prompt, opts)
          .then((value) => {
            if (!settled) writeLine({ type: "agent_res", id, ok: true, value });
          })
          .catch((err: unknown) => {
            if (!settled) {
              writeLine({
                type: "agent_res",
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
        return;
      }
      if (msg.type === "done") {
        killWorkerTree(proc);
        if (msg.ok) {
          finish(() => resolve({ value: msg.hasValue ? msg.value : undefined }));
        } else {
          finish(() => reject(new Error(String(msg.error ?? "workflow script failed"))));
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
                ? `workflow script failed (exit ${code}): ${detail}`
                : `workflow script exited unexpectedly (exit ${code})`,
            ),
          ),
        );
      }
    })();

    writeLine({
      type: "init",
      script: input.script,
      args: input.args,
      timeoutMs,
    });
  });
}
