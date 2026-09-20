import { type OutputBlockState, renderOutputBlock, renderToolHeader } from "@chengchenccc/tui";
import type { TodoItem } from "../../core/index.js";
import { shimmerText } from "./tui-format.js";
import type { TranscriptItem } from "./view-state.js";

export function renderTaskTool(item: TranscriptItem, expanded: boolean, width: number): string[] {
  const result = item.result;
  const asRecord = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const results = Array.isArray(asRecord(result).results)
    ? (asRecord(result).results as Array<Record<string, unknown>>)
    : [];
  // ADR 0028 shape for a BATCH: the pinned panel carried identity + progress
  // while it ran, and delegation_batch_completed landed the durable summary
  // (+ failures) in the transcript. The tool box would be a third copy of the
  // same facts, so it is transparent — before AND after the call. A single
  // (compat) spawn has no panel and keeps its box.
  if (item.streaming) return [];
  if (results.length > 0) return [];
  const label = typeof item.input?.label === "string" ? item.input.label : "";
  const body: string[] = [];
  const meta: string[] = [];
  // Settled single (compat) spawn result.
  const status =
    result && typeof result === "object" && "status" in result
      ? String((result as Record<string, unknown>).status)
      : "";
  if (status) body.push(`\u001b[2mstatus: ${status}\u001b[0m`);
  const content =
    typeof result?.content === "string"
      ? result.content
      : typeof result?.text === "string"
        ? result.text
        : "";
  const text = content.trim();
  if (text) body.push(`\u001b[2m${text.slice(0, expanded ? 400 : 160)}\u001b[0m`);
  if (body.length === 0) body.push("\u001b[2m(done)\u001b[0m");
  const state: OutputBlockState = "success";
  const header = renderToolHeader({
    icon: "\u25b6",
    title: `task${label ? ` \u00b7 ${label}` : ""}`,
    meta,
    titleColor: "\u001b[36m",
  });
  return renderOutputBlock({ header, state, sections: [{ lines: body }], width });
}

/** The fan-out's brief as its OWN card (omp renders the task batch's shared
 *  Goal/Constraints as a framed block above the agent rows): the user reads
 *  what the batch is for before watching who is doing it. Body lines keep the
 *  source's section shape — the model writes "Goal\n…\nConstraints\n…", so
 *  the card shows exactly that, dimmed, capped per window size. */
export function renderFanoutBriefChrome(goal: string, width: number, expanded = false): string[] {
  const lines = goal
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l, i, all) => l.trim().length > 0 || (i > 0 && i < all.length - 1));
  if (lines.length === 0) return [];
  const max = expanded ? 14 : 6;
  const shown = lines.slice(0, max);
  const body = shown.map((l) => {
    const trimmed = l.trim();
    if (!trimmed) return "";
    // Section headers are the CONTRACT (`# Goal` / `# Constraints` /
    // `# Contract`, see the task tool's `context` description), so they are
    // recognised by their marker rather than guessed from capitalization.
    // Bare capitalized lines in a bullet list ("- Use read/glob only") are
    // NOT headers.
    const heading = /^#{1,3}\s+/.test(trimmed);
    const text = heading ? trimmed.replace(/^#{1,3}\s+/, "") : trimmed;
    return heading
      ? `  \u001b[1m${text.slice(0, 140)}\u001b[0m`
      : `  \u001b[2m${text.slice(0, 140)}\u001b[0m`;
  });
  if (lines.length > shown.length) {
    body.push(`\u001b[2m  … ${lines.length - shown.length} more \u27e6ctrl+o\u27e7\u001b[0m`);
  }
  const header = renderToolHeader({
    icon: "\u21f6",
    title: "task brief",
    titleColor: "\u001b[36m",
  });
  return renderOutputBlock({ header, state: "running", sections: [{ lines: body }], width });
}

/** ADR 0028: live subagent activity as chrome (pinned above the editor,
 * like todo). One shimmering line per running agent, updated in place by
 * view-state; the block disappears entirely when no agent is live. */
export function renderLiveAgentsChrome(
  agents: readonly {
    label: string;
    text: string;
    outcome?: { ok: boolean; error?: string };
    toolCalls?: number;
    requests?: number;
    tokens?: number;
  }[],
  width: number,
  expanded = false,
): string[] {
  if (agents.length === 0) return [];
  const settled = agents.filter((a) => a.outcome).length;
  const running = agents.length - settled;
  const header = renderToolHeader({
    icon: "\u25b6",
    title: "agents",
    meta: [
      running > 0 ? `${running} running` : `${settled} settled`,
      ...(running > 0 && settled > 0 ? [`${settled} done`] : []),
    ],
    titleColor: "\u001b[36m",
  });
  // ctrl+o expands the panel to every agent (same gesture as tool detail);
  // collapsed it caps at 6 and says so, instead of silently dropping rows.
  const max = expanded ? Number.MAX_SAFE_INTEGER : 6;
  const shown = agents.slice(0, max);
  const body: string[] = [];
  body.push(
    ...shown.map((a) => {
      // Settled rows state their verdict (a failure keeps its error text
      // visible beside its still-running peers); running rows sweep.
      // Telemetry tail (omp per-row shape): what the agent has spent so far —
      // the part a watcher actually tracks. Absent counts render nothing.
      const tel: string[] = [];
      if ((a.toolCalls ?? 0) > 0) tel.push(`${a.toolCalls} \u2692`);
      if ((a.requests ?? 0) > 0) tel.push(`${a.requests} req`);
      if ((a.tokens ?? 0) > 0) tel.push(`${Math.round((a.tokens ?? 0) / 1000)}k tok`);
      const tail = tel.length > 0 ? ` \u001b[2m\u00b7 ${tel.join(" \u00b7 ")}\u001b[0m` : "";
      if (a.outcome) {
        const mark = a.outcome.ok ? "\u001b[32m\u2714\u001b[0m" : "\u001b[31m\u2718\u001b[0m";
        const detail = a.outcome.ok ? "" : `\u001b[31m: ${a.outcome.error ?? "failed"}\u001b[0m`;
        return `  ${mark} ${a.label}${tail}${detail}`;
      }
      return `  ${shimmerText(a.text)}${tail}`;
    }),
  );
  if (agents.length > shown.length) {
    const hidden = agents.length - shown.length;
    const hiddenRunning = agents.slice(max).filter((a) => !a.outcome).length;
    const state = hiddenRunning > 0 ? `${hiddenRunning} running` : "settled";
    body.push(
      `\u001b[2m  … ${hidden} more agent${hidden === 1 ? "" : "s"} (${state}) \u27e6ctrl+o\u27e7\u001b[0m`,
    );
  }
  // The panel is "running" while any agent is still live, "error" once a
  // settled failure is the most informative state, success when all passed.
  const failed = agents.some((a) => a.outcome && !a.outcome.ok);
  const state: OutputBlockState = running > 0 ? "running" : failed ? "error" : "success";
  return renderOutputBlock({ header, state, sections: [{ lines: body }], width });
}

/** Live chrome (pinned above the editor): the single todo surface. Framed
 * like every other block; once nothing is open (all done/cancelled, or the
 * list is empty) the component stops rendering entirely — a finished list
 * has no business occupying viewport. */
export function renderTodoChrome(items: readonly TodoItem[], width: number): string[] {
  if (items.length === 0) return [];
  const open = items.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
  if (open === 0) return [];
  const marks: Record<string, string> = {
    pending: "\u001b[2m○\u001b[0m",
    in_progress: "\u001b[36m●\u001b[0m",
    done: "\u001b[2m✓\u001b[0m",
    cancelled: "\u001b[2m✗\u001b[0m",
  };
  const done = items.filter((t) => t.status === "done").length;
  const header = renderToolHeader({
    icon: "☑",
    title: "todo",
    meta: [`${done}/${items.length} done`],
    titleColor: "\u001b[36m",
  });
  const MAX_ROWS = 6;
  const body: string[] = [];
  // Only the FIRST open row sweeps ("what am I doing now"); further
  // in_progress rows stay static so the chrome does not turn into a
  // fairground when a list is overly eager with its statuses.
  const sweepingId = items.find((t) => t.status === "in_progress")?.id;
  for (const t of items.slice(0, MAX_ROWS)) {
    const mark = marks[t.status] ?? marks.pending;
    if (t.status === "in_progress" && t.id === sweepingId)
      body.push(`${mark} ${shimmerText(t.text)}`);
    // Finished rows go dim + struck through: a closed item reads as crossed
    // out, not as another line of work.
    else if (t.status === "done") body.push(`${mark} \u001b[2m\u001b[9m${t.text}\u001b[0m`);
    else body.push(`${mark} ${t.text}`);
  }
  if (items.length > MAX_ROWS) {
    body.push(`\u001b[2m… ${items.length - MAX_ROWS} more\u001b[0m`);
  }
  return renderOutputBlock({
    header,
    // Ambient chrome: the "success" state's dim-gray border.
    state: "success",
    sections: [{ lines: body }],
    width,
  });
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

  // Settled hub calls are transparent: the panel carried a jobs/wait tree
  // live, the batch summary + settlement rows are the durable record, and the
  // output fetch's payload went to the model. The box would be a third copy.
  // While RUNNING it is the one place the wait's progress is visible — keep it.
  if (!item.streaming) return [];
  // While executing there is no result yet: show the running op instead of
  // a misleading empty-list/unknown-id fallback.
  if (result === undefined && item.streaming) {
    const snapshot = item.output?.trim().split("\n").slice(-2) ?? [];
    const lines = [`\u001b[2m${shimmerText(`⟳ ${op || "running"}…`)}\u001b[0m`, ...snapshot];
    return renderOutputBlock({
      header: renderToolHeader({
        icon: "◎",
        title: op ? `hub · ${op}` : "hub",
        titleColor: "\u001b[36m",
      }),
      state: "running",
      sections: [{ lines }],
      width,
    });
  }
  // Streaming wait with an existing result is still live: keep the last
  // snapshot visible below the result body (poll continuity).
  const liveSnapshot =
    item.streaming && item.output ? item.output.trim().split("\n").slice(-2) : [];
  for (const line of liveSnapshot) body.push(`\u001b[2m${line}\u001b[0m`);

  if (op === "jobs" || op === "wait") {
    const items = rows(result?.items ?? result?.waited);
    const timedOut = op === "wait" && result?.timedOut === true;
    // omp jobs.ts: agents (subagent handles) render as their OWN tree so
    // they never skew the job counts or the "waiting on N" title.
    const jobs = items.filter((r) => r.kind !== "subagent");
    const agents = items.filter((r) => r.kind === "subagent");
    if (items.length === 0) {
      if (op === "wait") {
        body.push(dim(timedOut ? "timed out" : "nothing to wait for"));
      } else {
        body.push(dim("(no background work)"));
      }
    } else {
      if (jobs.length > 0) {
        const tree = renderJobTree(jobs, timedOut, expanded);
        meta.push(tree.meta);
        body.push(...tree.lines);
      }
      if (agents.length > 0) {
        const tree = renderAgentTree(agents, expanded);
        meta.push(`${agents.length} agent${agents.length === 1 ? "" : "s"}`);
        body.push(...tree.lines);
      }
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
      if (result?.outputTruncated === true) {
        body.push(dim(`… output truncated (last ${output.length} chars)`));
      }
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
    const rowText = ` ${String(r.id)} (${String(r.kind)}) ${String(r.label ?? "").slice(0, 60)}`;
    // omp jobs.ts: running rows shimmer their label while the block is live;
    // settled rows render static dim so scrollback never freezes a band.
    const rest = st === "running" ? shimmerText(rowText) : dim(rowText);
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

/** Subagent handles as their own tree (omp agents run outside job control):
 * same row shape as the job tree but no counts meta — the header already
 * carries "N agents". */
function renderAgentTree(
  items: Array<Record<string, unknown>>,
  expanded: boolean,
): { lines: string[] } {
  const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
  const statusOf = (r: Record<string, unknown>): string => String(r.status ?? "?");
  const ORDER: Record<string, number> = { running: 0, failed: 1, stopped: 2, completed: 3 };
  const sorted = [...items].sort((a, b) => (ORDER[statusOf(a)] ?? 9) - (ORDER[statusOf(b)] ?? 9));
  const lines: string[] = [dim("  agents")];
  const max = expanded ? 12 : 6;
  const shown = sorted.slice(0, max);
  const truncated = sorted.length > shown.length;
  const ICONS: Record<string, string> = {
    running: "\u001b[36m⟳\u001b[0m",
    failed: "\u001b[31m✘\u001b[0m",
    stopped: "\u001b[31m✘\u001b[0m",
    completed: "\u001b[32m✔\u001b[0m",
  };
  shown.forEach((r, i) => {
    const st = statusOf(r);
    const isLast = i === shown.length - 1 && !truncated;
    const branch = isLast ? "└─" : "├─";
    const icon = ICONS[st] ?? "\u001b[32m✔\u001b[0m";
    const rowText = ` ${String(r.id)} ${String(r.label ?? "").slice(0, 60)}`;
    const rest = st === "running" ? shimmerText(rowText) : dim(rowText);
    lines.push(`  ${branch} ${icon}${rest}`);
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
  return { lines };
}

/** ask_question 结果块：题目 + 给过的选项 + 选中标记的持久记录（oh-my-pi 的
 *  askToolResult 同形）。答完一次 ask，transcript 里留下的应该是"问了什么、
 *  选了什么"，不是工具返回的裸 JSON。
 *
 *  与 hub 工具块相反的一侧：ask 在 RUNNING 时由停靠面板负责（它还占着
 *  loader 行），transcript 保持安静；settled 之后面板消失，这块才是记录。 */
export function renderAskTool(item: TranscriptItem, expanded: boolean, width: number): string[] {
  if (item.streaming) return [];
  const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
  const green = (s: string): string => `\u001b[32m${s}\u001b[0m`;
  const yellow = (s: string): string => `\u001b[33m${s}\u001b[0m`;

  const asRecord = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const questions = (
    Array.isArray(asRecord(item.input).questions)
      ? (asRecord(item.input).questions as unknown[])
      : []
  ).filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null);
  const result = asRecord(item.result);
  const answers = Array.isArray(result.answers)
    ? (result.answers as unknown[]).map(asRecord)
    : undefined;
  // A cancelled ask carries no answers: the tool fails closed with an error.
  const cancelled = answers === undefined;
  const errorText =
    typeof result.error === "string" && result.error !== "" ? result.error : undefined;

  const label = (q: Record<string, unknown>, i: number): string =>
    String(q.header ?? q.id ?? `Q${i + 1}`);
  const marker = (multi: boolean, on: boolean): string =>
    multi ? (on ? "\u2611" : "\u2610") : on ? "\u25c9" : "\u25cb";

  const sections: Array<{ label?: string; lines: string[] }> = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const answer = answers?.find((a) => a.id === q.id);
    const selected = new Set(
      Array.isArray(answer?.selectedValues) ? (answer.selectedValues as unknown[]).map(String) : [],
    );
    const freeText = typeof answer?.freeText === "string" ? answer.freeText : "";
    const multi = q.multi === true;
    const options = Array.isArray(q.options) ? (q.options as unknown[]).map(asRecord) : [];
    const lines: string[] = [];
    const questionText = String(q.question ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (questionText) lines.push(dim(questionText));
    for (const option of options) {
      const value = String(option.value ?? "");
      const on = selected.has(value);
      const text = String(option.label ?? value);
      lines.push(
        `${on ? green(marker(multi, true)) : dim(marker(multi, false))} ${on ? text : dim(text)}`,
      );
      // ctrl+o (tool detail) adds the option's own description: the answer
      // record is the same either way, the detail is what each choice meant.
      const description = typeof option.description === "string" ? option.description.trim() : "";
      if (expanded && description) lines.push(dim(`    \u21b3 ${description}`));
    }
    if (freeText) {
      // A free-text answer arrives either as the Other row (select) or as the
      // whole answer (text kind) — say which, so the record is unambiguous.
      const prefix = q.kind === "text" ? "" : "Other: ";
      lines.push(`${green(marker(multi, true))} ${prefix}\u201c${freeText}\u201d`);
    } else if (selected.size === 0) {
      lines.push(`${dim(marker(multi, false))} ${yellow(cancelled ? "cancelled" : "unanswered")}`);
    }
    sections.push({ label: `${i + 1}. ${label(q, i)}`, lines });
  }

  const state: OutputBlockState = errorText !== undefined ? "warning" : "success";
  const count = questions.length;
  const meta = [`${count} question${count === 1 ? "" : "s"}`];
  if (cancelled) meta.push("cancelled");
  const header = renderToolHeader({
    icon: errorText !== undefined ? "\u2298" : "\u2714",
    title: "ask",
    meta,
    titleColor: errorText !== undefined ? "\u001b[33m" : "\u001b[32m",
  });
  if (sections.length === 0) {
    return renderOutputBlock({
      header,
      state,
      sections: [{ lines: [errorText ?? "no questions"] }],
      width,
    });
  }
  if (errorText !== undefined && cancelled) {
    sections.push({ lines: [yellow(errorText)] });
  }
  return renderOutputBlock({ header, state, sections, width });
}
