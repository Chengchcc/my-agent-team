import {
  type OutputBlockState,
  renderOutputBlock,
  renderToolHeader,
  truncateToWidth,
} from "@chengchenccc/tui";
import type { TodoItem } from "../../core/index.js";
import type { TranscriptItem } from "./view-state.js";

/** omp-style plain-list task rendering (no card/box): batch/single spawn
 *  surface only — control ops render via renderHubTool. */
export function renderTaskTool(item: TranscriptItem, expanded: boolean): string[] {
  const label = typeof item.input?.label === "string" ? item.input.label : "";
  const lines: string[] = [`\u001b[36m  task${label ? ` · ${label}` : ""}\u001b[0m`];
  const result = item.result;
  const status =
    result && typeof result === "object" && "status" in result ? String(result.status) : "";
  if (status) lines.push(`\u001b[2m    status: ${status}\u001b[0m`);
  // Batch: { ok, content, results: [{index, name, agent, ok, text|error, ...}] }
  const asRecord = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const results = Array.isArray(asRecord(result).results)
    ? (asRecord(result).results as Array<Record<string, unknown>>)
    : [];
  if (results.length > 0) {
    for (const r of results) {
      const name = String(r.name ?? "");
      const agent = String(r.agent ?? "");
      const mark = r.ok === false ? "\u001b[31m✗\u001b[0m" : "\u001b[32m✔\u001b[0m";
      lines.push(`  ${mark} \u001b[2m${name}${agent ? ` (${agent})` : ""}\u001b[0m`);
      const text =
        typeof r.text === "string" && r.text !== ""
          ? r.text
          : typeof r.error === "string"
            ? r.error
            : "";
      if (text.trim()) {
        lines.push(`\u001b[2m    ${text.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
      }
    }
    return lines;
  }
  const content =
    typeof result?.content === "string"
      ? result.content
      : typeof result?.text === "string"
        ? result.text
        : "";
  if (content) {
    const text = content.trim();
    if (text) lines.push(`\u001b[2m    ${text.slice(0, expanded ? 400 : 160)}\u001b[0m`);
  }
  if (item.streaming) {
    lines.push(`\u001b[2m    ⟳ running…\u001b[0m`);
  } else if (lines.length === 1) {
    lines.push(`\u001b[2m    (done)\u001b[0m`);
  }
  return lines;
}

/** Live chrome (pinned above the editor): a compact snapshot of the
 *  current todo list. Unlike the transcript todo block this never scrolls
 *  away — the user always sees where the run stands. */
export function renderTodoChrome(items: readonly TodoItem[], width: number): string[] {
  if (items.length === 0) return [];
  const marks: Record<string, string> = {
    pending: "\u001b[2m○\u001b[0m",
    in_progress: "\u001b[36m●\u001b[0m",
    done: "\u001b[2m✓\u001b[0m",
    cancelled: "\u001b[2m✗\u001b[0m",
  };
  const done = items.filter((t) => t.status === "done").length;
  const lines = [`\u001b[2m  todo\u001b[0m ${done}/${items.length} done`];
  const MAX_ROWS = 6;
  for (const t of items.slice(0, MAX_ROWS)) {
    const mark = marks[t.status] ?? marks.pending;
    const text = t.status === "done" ? `\u001b[2m${t.text}\u001b[0m` : t.text;
    lines.push(truncateToWidth(`  ${mark} ${text}`, width));
  }
  if (items.length > MAX_ROWS) {
    lines.push(`\u001b[2m  … ${items.length - MAX_ROWS} more\u001b[0m`);
  }
  return lines;
}
/** hub 工具块：jobs/output/wait/steer/stop 的盒子渲染（omp framedBlock 风格）。
 * 计数头（"waiting on N of M · X done"）并入标题栏 meta，正文只留树/详情。 */
export function renderHubTool(item: TranscriptItem, expanded: boolean, width: number): string[] {
  const input = item.input as Record<string, unknown> | undefined;
  const op = typeof input?.op === "string" ? input.op : "";
  const result = item.result as Record<string, unknown> | undefined;
  const meta: string[] = [];
  const body: string[] = [];
  const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
  const rows = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  const maxChars = expanded ? 400 : 160;

  // While executing there is no result yet: show the running op instead of
  // a misleading empty-list/unknown-id fallback.
  if (result === undefined && item.streaming) {
    body.push(dim(`⟳ ${op || "running"}…`));
  } else if (op === "jobs" || op === "wait") {
    const items = rows(result?.items ?? result?.waited);
    const timedOut = op === "wait" && result?.timedOut === true;
    if (items.length === 0) {
      if (op === "wait") {
        body.push(dim(timedOut ? "timed out" : "nothing to wait for"));
      } else {
        body.push(dim("(no background work)"));
      }
    } else {
      const tree = renderJobTree(items, timedOut, expanded);
      meta.push(tree.meta);
      body.push(...tree.lines);
    }
  } else if (op === "output") {
    if (result?.ok === false) {
      body.push(`\u001b[31m${String(result.error ?? "failed")}\u001b[0m`);
    } else {
      const status = String(result?.status ?? "");
      if (status) body.push(dim(`status: ${status}`));
      const partial = typeof result?.partialText === "string" ? result.partialText : "";
      if (partial.trim()) body.push(dim(partial.trim().slice(0, maxChars)));
      const output = typeof result?.output === "string" ? result.output : "";
      if (output.trim()) body.push(dim(output.trim().slice(0, maxChars)));
      const nested = result?.result;
      if (nested && typeof nested === "object") {
        const text = String((nested as Record<string, unknown>).text ?? "");
        if (text.trim()) body.push(dim(text.trim().slice(0, maxChars)));
      }
      if (body.length === 0) body.push(dim("(unknown id)"));
    }
  } else {
    // steer / stop: { ok, error? }
    if (result?.ok === false) {
      body.push(`\u001b[31m${String(result.error ?? "failed")}\u001b[0m`);
    } else if (result !== undefined) {
      body.push(dim("ok"));
    }
  }

  let state: OutputBlockState = "success";
  if (item.streaming) state = "running";
  if (result?.ok === false) state = "error";
  const header = renderToolHeader({
    icon: "◎",
    title: op ? `hub · ${op}` : "hub",
    meta,
    titleColor: "\u001b[36m",
  });
  return renderOutputBlock({ header, state, sections: [{ lines: body }], width });
}

/** learn 工具块（omp Learn label + summary 风格）：展示教训正文而非 args JSON。 */
export function renderLearnTool(item: TranscriptItem, expanded: boolean): string[] {
  const lines: string[] = ["\u001b[36m  learn\u001b[0m"];
  const input = item.input as Record<string, unknown> | undefined;
  const memory = typeof input?.memory === "string" ? input.memory.trim() : "";
  if (memory) {
    const text = memory.replace(/\s+/g, " ").slice(0, expanded ? 400 : 160);
    lines.push(`\u001b[2m    ${text}\u001b[0m`);
  }
  const context =
    typeof input?.context === "string" && input.context.trim() ? input.context.trim() : "";
  if (context)
    lines.push(
      `\u001b[2m    @ ${context.replace(/\s+/g, " ").slice(0, expanded ? 200 : 80)}\u001b[0m`,
    );
  const result = item.result as Record<string, unknown> | undefined;
  if (result) {
    if (result.learned === true) {
      lines.push("\u001b[32m    ✓ stored\u001b[0m");
    } else if (result.reason) {
      lines.push(`\u001b[2m    ${String(result.reason)}\u001b[0m`);
    } else if (result.error) {
      lines.push(`\u001b[31m    ${String(result.error)}\u001b[0m`);
    }
  } else if (item.streaming) {
    lines.push("\u001b[2m    ⟳ capturing…\u001b[0m");
  }
  return lines;
}

/** omp hub-jobs tree: counts meta ("waiting on N of M · X done") for the box
 * header, plus running-first-sorted ├─/└─ rows with the partial-output
 * preview nested under each job. */
function renderJobTree(
  items: Array<Record<string, unknown>>,
  timedOut: boolean,
  expanded: boolean,
): { meta: string; lines: string[] } {
  const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
  const statusOf = (r: Record<string, unknown>): string => String(r.status ?? "?");
  const ORDER: Record<string, number> = { running: 0, failed: 1, stopped: 2, completed: 3 };
  const sorted = [...items].sort((a, b) => (ORDER[statusOf(a)] ?? 9) - (ORDER[statusOf(b)] ?? 9));
  const running = items.filter((r) => statusOf(r) === "running").length;
  const failed = items.filter((r) => {
    const s = statusOf(r);
    return s === "failed" || s === "stopped";
  }).length;
  const done = items.length - running - failed;
  const counts: string[] = [];
  if (done > 0) counts.push(`${done} done`);
  if (failed > 0) counts.push(`${failed} failed`);
  if (timedOut) counts.push("timed out");
  const head =
    running > 0
      ? `waiting on ${running} of ${items.length} job(s)`
      : `${items.length} job(s) settled`;
  const meta = [head, ...counts].join(" · ");

  const lines: string[] = [];
  const max = expanded ? 12 : 6;
  const shown = sorted.slice(0, max);
  const truncated = sorted.length > shown.length;
  shown.forEach((r, i) => {
    const st = statusOf(r);
    const isLast = i === shown.length - 1 && !truncated;
    const branch = isLast ? "└─" : "├─";
    const JOB_ICONS: Record<string, string> = {
      running: "\u001b[36m⟳\u001b[0m",
      failed: "\u001b[31m✘\u001b[0m",
      stopped: "\u001b[31m✘\u001b[0m",
      completed: "\u001b[32m✔\u001b[0m",
    };
    const icon = JOB_ICONS[st] ?? "\u001b[32m✔\u001b[0m";
    const rest = dim(` ${String(r.id)} (${String(r.kind)}) ${String(r.label ?? "").slice(0, 60)}`);
    lines.push(`  ${branch} ${icon}${rest}`);
    // Nested preview: first non-empty partial line under the branch.
    const partial = typeof r.partialText === "string" ? r.partialText : "";
    const preview = partial
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (preview) {
      const cont = isLast ? " " : "│";
      lines.push(dim(`  ${cont}   ${preview.slice(0, expanded ? 400 : 120)}`));
    }
  });
  if (truncated) lines.push(dim(`  … ${sorted.length - shown.length} more · (ctrl+o)`));
  return { meta, lines };
}
