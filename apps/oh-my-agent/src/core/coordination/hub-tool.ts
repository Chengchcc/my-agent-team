import type { PluginTool } from "../agent-runtime.js";
import type { EntryRow, RegistryEntry } from "./registry.js";

export interface HubToolDeps {
  readonly scope: string;
  readonly list: (scope: string) => EntryRow[];
  readonly get: (id: string) => RegistryEntry | undefined;
  readonly wait: (opts: {
    ids?: readonly string[];
    scope: string;
    timeoutMs: number;
  }) => Promise<{ settled: EntryRow[]; timedOut: boolean }>;
  readonly stop: (id: string) => { ok: boolean; error?: string };
  readonly steer: (handle: string, prompt: string) => { ok: boolean; error?: string };
}

/** Unified coordination surface for background work (pi hub, jobs half):
 *  bash/eval process jobs and delegation subagents in one registry view. */
export function createHubTool(deps: HubToolDeps): readonly PluginTool[] {
  const hub: PluginTool = {
    name: "hub",
    description:
      "Unified coordination for background work. jobs: snapshot of all background " +
      "bash/eval jobs and task subagents (id, kind, status, label, partial). output: " +
      "fetch one entry by id (streaming partialText while running, final result when " +
      "settled). wait: block until one of the given ids settles (default: all running) " +
      "or timeoutMs (0 = indefinite) elapses; returns the settled snapshot. steer: inject a message into a RUNNING " +
      "subagent. stop: kill a bash/eval job or stop a subagent.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["jobs", "output", "wait", "steer", "stop"] },
        id: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        prompt: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["op"],
    },
    async execute(args) {
      const op = typeof args.op === "string" ? args.op : "";
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const ids = Array.isArray(args.ids)
        ? (args.ids as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
      switch (op) {
        case "jobs":
          return { items: deps.list(deps.scope) };
        case "output": {
          if (!id) return { ok: false, error: "id is required" };
          const e = deps.get(id);
          if (!e) return { ok: false, error: `unknown id "${id}"` };
          return {
            id: e.id,
            kind: e.kind,
            status: e.status,
            label: e.label,
            ...(e.partialText ? { partialText: e.partialText } : {}),
            ...(e.output !== undefined ? { output: e.output } : {}),
            ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
            ...(e.isError !== undefined ? { isError: e.isError } : {}),
            ...(e.result ? { result: e.result } : {}),
          };
        }
        case "wait": {
          const out = await deps.wait({ ids, scope: deps.scope, timeoutMs });
          return { waited: out.settled, timedOut: out.timedOut };
        }
        case "steer": {
          if (!id) return { ok: false, error: "id is required" };
          if (!prompt) return { ok: false, error: "prompt is required" };
          return deps.steer(id, prompt);
        }
        case "stop": {
          if (!id) return { ok: false, error: "id is required" };
          return deps.stop(id);
        }
        default:
          return {
            ok: false,
            error: `unknown op "${op}" (jobs|output|wait|steer|stop)`,
          };
      }
    },
  };
  return [hub];
}
