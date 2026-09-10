import type { PluginTool } from "../agent-runtime.js";
import { isValidWorkflowName } from "../delegation/roles.js";

export interface OrchestrationScriptResult {
  readonly ok: boolean;
  readonly totalTokens: number;
  readonly value: unknown;
}

export interface OrchestrateToolDeps {
  /** Executes an orchestration script in the vm sandbox. */
  readonly runScript: (input: {
    script: string;
    args?: unknown;
  }) => Promise<OrchestrationScriptResult>;
  /** Persist a script to `<workspace>/.oma/workflow/<name>.js` for reuse. */
  readonly writeScript: (name: string, content: string) => void;
  /** Load a saved script by name (B8: `workflow_run({name})` re-runs a
   *  saved workflow without re-supplying the body). null = not found. */
  readonly readScript: (name: string) => Promise<string | null>;
}

export function createOrchestrateTool(deps: OrchestrateToolDeps): readonly PluginTool[] {
  const runScript: PluginTool = {
    name: "workflow_run",
    description:
      "Run an orchestration script (top-level-await JS) that fans out subagents " +
      "via agent(prompt, {schema?, label?}) and pipeline(items, fn). Scripts have " +
      "NO fs/network access - agents do the work. Save reusable scripts with the " +
      "name argument (written to .oma/workflow/<name>.js), then re-run one later " +
      "with ONLY the name argument (loads the saved script).",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        // script XOR name: either a new body, or a saved workflow to re-run
        // (the runtime enforces the XOR — at least one must be present).
        script: { type: "string", maxLength: 32768 },
        name: { type: "string" },
        args: { type: "object" },
      },
    },
    async execute(args) {
      const rawScript = typeof args.script === "string" ? args.script : "";
      const name = typeof args.name === "string" && args.name.length > 0 ? args.name : null;
      if (name && !isValidWorkflowName(name)) {
        return { ok: false, error: `invalid workflow name (allowed: [a-z0-9-], max 64): ${name}` };
      }
      if (rawScript && name) deps.writeScript(name, rawScript);
      let script = rawScript;
      if (!script && name) {
        const saved = await deps.readScript(name);
        if (saved === null) {
          return { ok: false, error: `workflow "${name}" not found in .oma/workflow` };
        }
        script = saved;
      }
      if (!script) return { ok: false, error: "script or name is required" };
      const result = await deps.runScript({ script, args: args.args });
      return {
        ok: result.ok,
        totalTokens: result.totalTokens,
        value: result.value,
        scriptSaved: Boolean(rawScript && name),
      };
    },
  };
  return [runScript];
}
