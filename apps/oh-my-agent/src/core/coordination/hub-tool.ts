import type { PluginTool } from "../index.js";
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

/** Model-facing markdown for a job snapshot (omp buildJobResult flavor):
 * Completed sections with label + fenced preview, Still Running bullets.
 * The TUI keeps rendering from the structured rows; only the tool_result
 * text changes from a JSON dump to readable markdown. */
function formatJobRowsMarkdown(rows: readonly EntryRow[]): string {
  const lines: string[] = [];
  const completed = rows.filter((r) => r.status !== "running");
  const running = rows.filter((r) => r.status === "running");
  if (completed.length > 0) {
    lines.push(`## Completed (${completed.length})`, "");
    for (const j of completed) {
      lines.push(`### ${j.id} [${j.kind}] — ${j.status}`);
      lines.push(`Label: ${j.label}`);
      if (j.partialText.trim()) lines.push("```", j.partialText.trim(), "```");
      lines.push("");
    }
  }
  if (running.length > 0) {
    lines.push(`## Still Running (${running.length})`, "");
    for (const j of running) lines.push(`- \`${j.id}\` [${j.kind}] — ${j.label}`);
  }
  return lines.length === 0 ? "No background work." : lines.join("\n").trimEnd();
}

/** Model-facing cap on one hub output fetch: settled registry output is
 * uncapped truth, so the tool result carries only the tail. */
const HUB_OUTPUT_MAX_CHARS = 10_000;

/** A `wait` that streams live "still waiting on N" snapshots through
 * onOutput every SNAPSHOT_MS until the underlying wait resolves. The
 * snapshots list the running job ids so the TUI block stays informative
 * without a second tree. */
const WAIT_SNAPSHOT_MS = 500;

async function streamWait(
  deps: HubToolDeps,
  opts: { ids?: readonly string[]; timeoutMs: number },
  onOutput: ((text: string) => void) | undefined,
): Promise<{ settled: EntryRow[]; timedOut: boolean }> {
  const wait = deps.wait({ ids: opts.ids, scope: deps.scope, timeoutMs: opts.timeoutMs });
  if (!onOutput) return wait;
  let snapshot = "";
  const timer = setInterval(() => {
    // Single-line running summary: ids + count, no full tree (the result
    // block owns the tree when the wait settles).
    const running = deps
      .list(deps.scope)
      .filter((r) => r.status === "running")
      .map((r) => r.id);
    const watched = opts.ids ? running.filter((id) => opts.ids?.includes(id)) : running;
    const next = `waiting · ${watched.length} running (${watched.slice(0, 5).join(", ")})`;
    if (next !== snapshot) {
      snapshot = next;
      onOutput(`${next}\n`);
    }
  }, WAIT_SNAPSHOT_MS);
  timer.unref?.();
  try {
    return await wait;
  } finally {
    clearInterval(timer);
  }
}

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
    async execute(args, _signal, options) {
      const op = typeof args.op === "string" ? args.op : "";
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const ids = Array.isArray(args.ids)
        ? (args.ids as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
      switch (op) {
        case "jobs": {
          const items = deps.list(deps.scope);
          return { content: formatJobRowsMarkdown(items), items };
        }
        case "output": {
          if (!id) return { ok: false, error: "id is required" };
          const e = deps.get(id);
          if (!e) return { ok: false, error: `unknown id "${id}"` };
          const out: Record<string, unknown> = {
            id: e.id,
            kind: e.kind,
            status: e.status,
            label: e.label,
          };
          if (e.partialText) out.partialText = e.partialText;
          if (e.output !== undefined) {
            // Settled output is uncapped truth; cap the model-facing tail here.
            out.output = e.output.slice(-HUB_OUTPUT_MAX_CHARS);
            if (e.output.length > HUB_OUTPUT_MAX_CHARS) {
              out.outputTruncated = true;
            }
          }
          if (e.exitCode !== undefined) out.exitCode = e.exitCode;
          if (e.isError !== undefined) out.isError = e.isError;
          if (e.result) out.result = e.result;
          return out;
        }
        case "wait": {
          // Live snapshot while waiting (omp job-watching waits stream
          // onUpdate every 500ms): onOutput feeds the TUI's tool_output
          // tail so the block is alive instead of a frozen spinner.
          const out = await streamWait(deps, { ids, timeoutMs }, options?.onOutput);
          const text = out.timedOut
            ? "Wait timed out with nothing newly settled."
            : formatJobRowsMarkdown(out.settled);
          return { content: text, waited: out.settled, timedOut: out.timedOut };
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
