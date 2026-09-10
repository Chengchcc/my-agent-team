import type { Tool } from "@chengchenccc/message";
import { runInSandbox } from "@chengchenccc/sandbox";
import {
  getEntry,
  notifyEntryCompletion,
  registerEntry,
  updateEntry,
} from "../coordination/registry.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining what this code evaluates.",
};

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

let nextJobSeq = 1;

/** eval: run a TS/JS snippet in a process sandbox (spawned bun subprocess,
 *  minimal env, hard timeout). The snippet must `export default (ctx) => out`
 *  where ctx is the JSON `input` object. Output is the returned value; stdout
 *  and stderr are reported alongside. Files written next to the script live
 *  only for the run unless keepWorkspace is set (cwd = workspace eval dir). */
export function createEvalTool(opts: { workspaceRoot: string; scope: string }): Tool {
  const scope = opts.scope;

  return {
    name: "eval",
    description:
      "Evaluate a TypeScript/JavaScript snippet in an isolated sandbox process. The code must `export default async (ctx) => result` — ctx is the provided input object and result must be JSON-serializable. Use for computations, data shaping, and quick experiments instead of bash one-liners. " +
      "Supports background execution (async); collect with the hub tool (output/wait).",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        code: {
          type: "string",
          description:
            "TS/JS module source. Must `export default async (ctx) => result`. Omit when async is set.",
        },
        input: {
          type: "object",
          description: "JSON object passed to the snippet as ctx",
          additionalProperties: true,
        },
        async: {
          type: "boolean",
          description:
            "Run in the background: returns a job id immediately. Collect with the hub tool " +
            "(output/wait); the job keeps running until its timeout.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 30000). 0 disables the deadline.",
        },
        keepWorkspace: {
          type: "boolean",
          description: "Keep the sandbox working dir across this session (default false)",
        },
      },
      required: ["description"],
    },
    async execute(input: Record<string, unknown>, signal?: AbortSignal) {
      const {
        code,
        input: ctxInput,
        timeout = envMs("OMA_EVAL_TIMEOUT_MS", 30_000),
        keepWorkspace = false,
      } = input as {
        code: string;
        input?: Record<string, unknown>;
        timeout?: number;
        keepWorkspace?: boolean;
      };

      if (typeof code !== "string" || code.trim() === "") {
        return { content: "eval requires non-empty code", isError: true };
      }

      // pi semantics: timeout 0 disables the deadline entirely (long
      // parses/compiles). Otherwise model-controlled values stay clamped —
      // an unbounded timeout parks a sandbox slot indefinitely.
      const requested = Number(timeout);
      const clampedTimeout =
        requested === 0 ? 0 : Math.min(Math.max(requested || 30_000, 1_000), 600_000);

      const runCell = async (
        runnerSignal?: AbortSignal,
      ): Promise<{ content: string; isError: boolean; exitCode: number | null }> => {
        try {
          const r = await runInSandbox({
            code,
            input: ctxInput ?? {},
            timeoutMs: clampedTimeout,
            keepCwd: keepWorkspace,
            signal: runnerSignal,
          });
          const parts: string[] = [];
          if (r.output !== null) parts.push(JSON.stringify(r.output, null, 2));
          if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
          if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
          const ok = r.exitCode === 0;
          return {
            content: ok
              ? parts.join("\n\n") || "(no output)"
              : `eval failed (exit ${r.exitCode}):\n${parts.join("\n\n")}`,
            isError: !ok,
            exitCode: r.exitCode,
          };
        } catch (err) {
          return {
            content: `eval error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
            exitCode: null,
          };
        }
      };

      // Background execution (M-eval): register in the coordination registry
      // and return a job id immediately. The explicit timer (0 = no deadline)
      // drives the abort signal and the timedOut verdict.
      if ((input as { async?: boolean }).async === true) {
        const id = `eval_${nextJobSeq++}`;
        const controller = new AbortController();
        let timedOut = false;
        let killed = false;
        const { promise: settle, resolve: settleResolve } = Promise.withResolvers<void>();
        const reg = registerEntry({
          id,
          kind: "eval",
          scope,
          label: code.slice(0, 80),
          startedAt: Date.now(),
          status: "running",
          finishedAt: null,
          partialText: "",
          settle,
          kill: () => {
            killed = true;
            controller.abort();
          },
        });
        if (!reg.ok) return { content: `Error: ${reg.error}`, isError: true };
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (clampedTimeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, clampedTimeout);
        }
        void (async () => {
          const done = await runCell(controller.signal);
          if (timer) clearTimeout(timer);
          updateEntry(id, {
            status: done.isError ? "failed" : "completed",
            finishedAt: Date.now(),
            exitCode: done.exitCode,
            timedOut,
            killed,
            output: done.content.slice(-2000),
            isError: done.isError,
          });
          settleResolve();
          const e = getEntry(id);
          if (e) notifyEntryCompletion(e);
        })().catch(() => settleResolve());
        return {
          content: `Backgrounded as job ${id}; collect with hub { "op": "output", "id": "${id}" } or hub { "op": "wait", "ids": ["${id}"] }.`,
        };
      }

      if (signal?.aborted) return { content: "aborted", isError: true };
      return runCell(signal);
    },
  };
}
