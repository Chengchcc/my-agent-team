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

/** omp-style plain-list task rendering (no card/box). Covers the
 *  delegation surface: task (batch/single), task_list, task_output. */
export function renderTaskTool(item: TranscriptItem, expanded: boolean): string[] {
  const toolName = item.text.replace(/…$/, "");
  const label = typeof item.input?.label === "string" ? item.input.label : "";
  const title = `${toolName}${label ? ` · ${label}` : ""}`;
  const lines: string[] = [`\u001b[36m  ${title}\u001b[0m`];
  const result = item.result;
  const asRecord = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  // task_list: { tasks: [{handle, label, status, usage?}] }
  if (toolName === "task_list" && result && Array.isArray(asRecord(result).tasks)) {
    const tasks = asRecord(result).tasks as Array<Record<string, unknown>>;
    if (tasks.length === 0) lines.push("\u001b[2m    (no live tasks)\u001b[0m");
    for (const t of tasks) {
      const status = String(t.status ?? "?");
      const mark =
        status === "running"
          ? "\u27f3"
          : status === "failed" || status === "stopped"
            ? "\u2718"
            : "\u2714";
      lines.push(`\u001b[2m  ${mark} ${String(t.label ?? t.handle ?? "")} [${status}]\u001b[0m`);
    }
    return lines;
  }
  // task_output: { handle, status, partialText?, result: SubagentResult }
  if (toolName === "task_output") {
    const status = String(asRecord(result).status ?? "");
    if (status) lines.push(`\u001b[2m    status: ${status}\u001b[0m`);
    const partialText = String(asRecord(result).partialText ?? "");
    if (partialText.trim()) {
      lines.push(`\u001b[2m    ${partialText.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
    }
    const nested = asRecord(result).result;
    if (nested && typeof nested === "object") {
      const nestedText = String(asRecord(nested).text ?? "");
      if (nestedText.trim()) {
        lines.push(`\u001b[2m    ${nestedText.trim().slice(0, expanded ? 400 : 160)}\u001b[0m`);
      }
    }
    if (lines.length === 1) lines.push("\u001b[2m    (unknown handle)\u001b[0m");
    return lines;
  }
  const status = String(asRecord(result).status ?? "");
  if (status) lines.push(`\u001b[2m    status: ${status}\u001b[0m`);
  // Batch: { ok, content, results: [{index, name, agent, ok, text|error, ...}] }
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
  // Single mode / script result: content or top-level text.
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
