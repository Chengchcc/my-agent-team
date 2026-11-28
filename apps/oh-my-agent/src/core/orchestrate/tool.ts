import { isValidWorkflowName } from "../delegation/roles.js";
import type { PluginTool } from "../index.js";
import type { Usage } from "../runtime/contract/index.js";

export interface OrchestrationScriptResult {
  readonly ok: boolean;
  readonly totalTokens: number;
  readonly usage: Usage;
  readonly value: unknown;
  readonly logs: readonly string[];
}

export interface OrchestrateToolDeps {
  /** Executes an orchestration script in the isolated subprocess VM. */
  readonly runScript: (input: {
    script: string;
    args?: unknown;
    label?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<OrchestrationScriptResult>;
  /** Persist a script to `<workspace>/.oma/orchestrations/<name>.js` for reuse. */
  readonly writeScript: (name: string, content: string) => void;
  /** Load a saved script by name (`orchestrate({ name })` re-runs a saved
   *  script without re-supplying the body). null = not found. */
  readonly readScript: (name: string) => Promise<string | null>;
}

const MAX_ORCHESTRATE_TIMEOUT_MS = 60 * 60_000;

export function createOrchestrateTool(deps: OrchestrateToolDeps): readonly PluginTool[] {
  const orchestrate: PluginTool = {
    name: "orchestrate",
    description:
      "Run a dynamic orchestration script (top-level-await JS in an isolated subprocess) when " +
      "control flow itself is code: multi-stage pipelines, loops/retries, conditional branching, " +
      "or large map-reduce fan-outs without polluting the main context. " +
      "Primitives: " +
      "agent(prompt, { role?, model?, tools?, schema?, label?, timeoutMs? }) -> { ok, label, text, output?, error?, artifacts?, usage? } " +
      "(roles: task, explore, plan, or .oma/agents/<name>.md); " +
      "parallel(items, fn, { concurrency? }) (alias: pipeline); " +
      "tool(name, input) for read-only workspace inspection (glob, grep, read, ls, tree); " +
      "phase(name, fn) for live stage progress; console.log(...) for logs; global `args`. " +
      "Scripts have NO direct fs/network/write access — use agent() for edits or bash. " +
      "Save reusable scripts with `name` (.oma/orchestrations/<name>.js), then re-run later with ONLY `name`.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        // script XOR name: either a new body, or a saved script to re-run
        // (the runtime enforces that at least one is present).
        script: { type: "string", maxLength: 32768 },
        name: { type: "string" },
        args: { type: "object" },
        timeoutMs: {
          type: "number",
          description:
            "Optional total wall-clock timeout in ms (default 1800000 = 30 min, max 3600000).",
        },
      },
    },
    async execute(args, signal) {
      const rawScript = typeof args.script === "string" ? args.script : "";
      const name = typeof args.name === "string" && args.name.length > 0 ? args.name : null;
      if (name && !isValidWorkflowName(name)) {
        return {
          ok: false,
          error: `invalid orchestration name (allowed: [a-z0-9-], max 64): ${name}`,
          isError: true,
        };
      }
      if (rawScript && name) deps.writeScript(name, rawScript);
      let script = rawScript;
      if (!script && name) {
        const saved = await deps.readScript(name);
        if (saved === null) {
          return {
            ok: false,
            error: `orchestration "${name}" not found in .oma/orchestrations`,
            isError: true,
          };
        }
        script = saved;
      }
      if (!script) return { ok: false, error: "script or name is required", isError: true };
      const rawTimeout = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
      const timeoutMs =
        rawTimeout !== undefined && Number.isFinite(rawTimeout) && rawTimeout > 0
          ? Math.min(Math.floor(rawTimeout), MAX_ORCHESTRATE_TIMEOUT_MS)
          : undefined;
      const result = await deps.runScript({
        script,
        args: args.args,
        ...(name ? { label: name } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      });
      return {
        ok: result.ok,
        totalTokens: result.totalTokens,
        usage: result.usage,
        value: result.value,
        ...(result.logs.length > 0 ? { logs: result.logs } : {}),
        scriptSaved: Boolean(rawScript && name),
      };
    },
  };
  return [orchestrate];
}
