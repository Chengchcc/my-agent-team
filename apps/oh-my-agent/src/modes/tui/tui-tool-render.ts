import { truncateToWidth } from "@chengchenccc/tui";
import type { TodoItem } from "../../core/index.js";
import type { TranscriptItem } from "./view-state.js";

/** omp-style plain-list todo rendering (no card/box). */
export function renderTodoTool(item: TranscriptItem, expanded: boolean): string[] {
  const lines: string[] = ["\u001b[36m  todo\u001b[0m"];
  const items = todoItems(item);
  if (items.length === 0) return ["\u001b[36m  todo\u001b[0m", "\u001b[2m    (no items)\u001b[0m"];
  for (const it of items) {
    const mark =
      it.status === "done"
        ? "\u001b[32m✓\u001b[0m"
        : it.status === "in_progress"
          ? "\u001b[33m●\u001b[0m"
          : it.status === "cancelled"
            ? "\u001b[31m✗\u001b[0m"
            : "\u001b[2m☐\u001b[0m";
    lines.push(`  ${mark} ${it.text}`);
  }
  if (!expanded) {
    const open = items.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
    if (open > 0) lines.push(`\u001b[2m    ${open} open — (ctrl+o for full list)\u001b[0m`);
  }
  return lines;
}

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
/** hub 工具块：jobs/output/wait/steer/stop 的纯文本渲染。 */
export function renderHubTool(item: TranscriptItem, expanded: boolean): string[] {
  const input = item.input as Record<string, unknown> | undefined;
  const op = typeof input?.op === "string" ? input.op : "";
  const header = op
    ? `\u001b[36m  hub\u001b[0m \u001b[2m· ${op}\u001b[0m`
    : "\u001b[36m  hub\u001b[0m";
  const lines: string[] = [header];
  // While executing there is no result yet: show the running op instead of
  // a misleading empty-list/unknown-id fallback.
  if (item.result === undefined && item.streaming) {
    lines.push(`\u001b[2m    ⟳ ${op || "running"}…\u001b[0m`);
    return lines;
  }
  const result = item.result as Record<string, unknown> | undefined;
  const rows = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  if (op === "jobs" || op === "wait") {
    const items = rows(result?.items ?? result?.waited);
    if (items.length === 0) {
      lines.push(
        op === "wait"
          ? `\u001b[2m    ${result?.timedOut ? "timed out" : "nothing to wait for"}\u001b[0m`
          : "\u001b[2m    (no background work)\u001b[0m",
      );
      return lines;
    }
    const timedOut = op === "wait" && result?.timedOut === true;
    lines.push(...renderJobTree(items, timedOut, expanded));
    return lines;
  }
  if (op === "output") {
    if (result?.ok === false) {
      lines.push(`\u001b[31m    ${String(result.error ?? "failed")}\u001b[0m`);
      return lines;
    }
    const status = String(result?.status ?? "");
    if (status) lines.push(`\u001b[2m    status: ${status}\u001b[0m`);
    const partial = typeof result?.partialText === "string" ? result.partialText : "";
    if (partial.trim()) {
      lines.push(`\u001b[2m    ${partial.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
    }
    const output = typeof result?.output === "string" ? result.output : "";
    if (output.trim()) {
      lines.push(`\u001b[2m    ${output.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
    }
    const nested = result?.result;
    if (nested && typeof nested === "object") {
      const text = String((nested as Record<string, unknown>).text ?? "");
      if (text.trim()) {
        lines.push(`\u001b[2m    ${text.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
      }
    }
    if (lines.length === 1) lines.push("\u001b[2m    (unknown id)\u001b[0m");
    return lines;
  }
  // steer / stop: { ok, error? }
  const ok = result?.ok;
  if (result) {
    lines.push(
      ok === false
        ? `\u001b[31m    ${String(result.error ?? "failed")}\u001b[0m`
        : "\u001b[2m    ok\u001b[0m",
    );
  } else if (item.streaming) {
    lines.push("\u001b[2m    ⟳ waiting…\u001b[0m");
  }
  return lines;
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

function todoItems(item: TranscriptItem): Array<{ id: string; text: string; status: string }> {
  const candidates: unknown[] = [];
  const result = item.result as Record<string, unknown> | undefined;
  if (result) {
    if (Array.isArray(result.items)) candidates.push(...result.items);
    const content = typeof result.content === "string" ? result.content : "";
    if (content) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (Array.isArray(parsed.items)) candidates.push(...parsed.items);
      } catch {
        // keep raw string path below
      }
    }
  }
  if (item.input && Array.isArray(item.input.items))
    candidates.push(...(item.input.items as unknown[]));
  return candidates
    .filter(
      (v): v is { id: string; text: string; status: string } =>
        typeof v === "object" &&
        v !== null &&
        "text" in v &&
        typeof (v as { text: unknown }).text === "string" &&
        "status" in v &&
        typeof (v as { status: unknown }).status === "string",
    )
    .map((v) => ({
      id: "id" in v && typeof v.id === "string" ? v.id : "",
      text: (v as { text: string }).text,
      status: (v as { status: string }).status,
    }));
}

/** omp hub-jobs tree: a counts header ("waiting on N of M · X done"),
 *  running-first sort, and ├─/└─ connector rows with the partial-output
 *  preview nested under each job. */
function renderJobTree(
  items: Array<Record<string, unknown>>,
  timedOut: boolean,
  expanded: boolean,
): string[] {
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
  const meta: string[] = [];
  if (done > 0) meta.push(`${done} done`);
  if (failed > 0) meta.push(`${failed} failed`);
  if (timedOut) meta.push("timed out");
  const head =
    running > 0
      ? `waiting on ${running} of ${items.length} job(s)`
      : `${items.length} job(s) settled`;
  const header = [`  ${head}`, ...meta].join(" · ");
  const lines: string[] = [dim(header)];

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
  return lines;
}
