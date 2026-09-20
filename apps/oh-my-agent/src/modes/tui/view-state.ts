import type { BackendRunOutcome } from "@chengchenccc/agent-contract";
import { tuiTheme } from "@chengchenccc/tui";
import type { OmaLoopEvent, TodoItem } from "../../core/index.js";
import { formatDurationMs } from "./tui-format.js";

/** Pure view model for the TUI transcript: folds OmaLoopEvents into the
 *  lines the renderer draws. No terminal I/O - fully unit-testable. */

export interface TranscriptItem {
  kind: "user" | "assistant" | "thinking" | "tool" | "status" | "error";
  /** For assistant/thinking: the accumulated text. For tool: "name summary".
   *  For user: the input text. For status/error: the message. */
  text: string;
  /** Streaming items grow in place; settled items are immutable. */
  streaming: boolean;
  /** Assistant items only: omp-style thinking block rendered before text. */
  thinking?: string;
  /** User items only: true while the message is steered into a live run or
   *  queued for the next one (rendered dim with a » marker, pi's steering
   *  display) — distinguishes injections from fresh prompts. */
  pending?: boolean;
  /** Tool items only: the model call args (from tool_execution_start). */
  input?: Readonly<Record<string, unknown>>;
  /** Tool items only: the execution result (from tool_execution_end). */
  result?: Readonly<Record<string, unknown>>;
  /** Tool items only: streaming partial output while executing. */
  output?: string;
  /** Tool items only: wall-clock start (set on tool_execution_start). */
  startedAt?: number;
  /** Tool items only: execution duration (set on tool_execution_end). */
  durationMs?: number;
  /** Tool items only: wall-clock timeout ms (0 = disabled). */
  timeoutMs?: number;
}

/** One completed or in-flight run as shown in the transcript. */
export interface RunViewState {
  /** Items of this run, in order. */
  items: TranscriptItem[];
  /** True between agent_start and agent_end. */
  running: boolean;
  /** Source of the fan-out whose lines currently belong to the pinned panel.
   *  "task" = the panel carries the detail, so the transcript keeps only a
   *  one-line summary (+ failures); undefined / "workflow" = no panel, the
   *  transcript keeps its per-agent status lines. */
  fanoutSource?: "task" | "workflow";
}

export interface LiveAgentLine {
  agentId: string;
  label: string;
  /** Latest activity: "▶ started" / "⚙ label · tool" / answer tail. */
  text: string;
  /** Set when this agent settled. The line STAYS in the panel (a failed
   *  sibling belongs beside its live peers, not alone in the transcript)
   *  until delegation_batch_completed lands the batch's terminal markers. */
  outcome?: { ok: boolean; error?: string };
  /** Progress telemetry, the part a user actually watches: tool calls made,
   *  model requests issued, tokens spent (omp shows the same trio per row). */
  toolCalls?: number;
  requests?: number;
  tokens?: number;
  /** Wall-clock start, for the settled row's "(2m9s)" (omp's row shape). */
  startedAt?: number;
  durationMs?: number;
}

export interface TuiViewState {
  runs: RunViewState[];
  /** The current fan-out's shared brief (task `context`): the panel shows it
   *  so the pinned block answers "what is this batch doing" without the user
   *  opening a tool result. Cleared with the panel. */
  fanoutGoal?: string;
  /** ctrl+t: show full thinking blocks (default: collapsed first line). */
  showThinking: boolean;
  /** ctrl+o: show full tool args/result JSON (default: one-line previews). */
  showToolDetail: boolean;
  /** Latest todo snapshot (todo_update events): rendered as live chrome
   *  pinned above the editor, never scrolled away with the transcript. */
  todoItems: readonly TodoItem[];
  /** Live subagent activity (delegation events), rendered as live chrome
   *  like todo — pinned above the editor while agents run, gone when the
   *  batch settles. The transcript keeps only the terminal ✔/✘ markers. */
  liveAgents: Map<string, LiveAgentLine>;
}

export function initialViewState(): TuiViewState {
  return {
    runs: [],
    showThinking: false,
    showToolDetail: false,
    todoItems: [],
    liveAgents: new Map(),
  };
}

function currentRun(state: TuiViewState): RunViewState | undefined {
  return state.runs.at(-1);
}

function ensureRunningRun(state: TuiViewState): RunViewState {
  const run = currentRun(state);
  if (run?.running) return run;
  const fresh: RunViewState = { items: [], running: true };
  state.runs.push(fresh);
  return fresh;
}

function lastOfKind(run: RunViewState, kind: TranscriptItem["kind"]): TranscriptItem | undefined {
  for (let i = run.items.length - 1; i >= 0; i--) {
    const item = run.items[i]!;
    if (item.kind === kind && item.streaming) return item;
  }
  return undefined;
}

/** Fold one event into the view state (mutates for efficiency - the state
 *  is rebuilt per session, not diffed). */
export function applyEvent(state: TuiViewState, event: OmaLoopEvent): void {
  switch (event.type) {
    case "agent_start":
    case "turn_start": {
      ensureRunningRun(state);
      break;
    }
    case "message_start": {
      const run = ensureRunningRun(state);
      // A thinking-first provider may have already opened an assistant
      // placeholder via thinking_update; reuse it so thinking stays above
      // the text instead of becoming a separate item below it.
      const existing = lastOfKind(run, "assistant");
      if (existing) {
        existing.thinking ??= "";
      } else {
        run.items.push({ kind: "assistant", text: "", streaming: true, thinking: "" });
      }
      break;
    }
    case "message_update": {
      const run = currentRun(state);
      const item = run && lastOfKind(run, "assistant");
      if (item) item.text += event.text;
      break;
    }
    case "thinking_update": {
      const run = ensureRunningRun(state);
      let item = lastOfKind(run, "assistant");
      if (!item) {
        item = { kind: "assistant", text: "", streaming: true, thinking: "" };
        run.items.push(item);
      }
      item.thinking = `${item.thinking ?? ""}${event.text}`;
      break;
    }
    case "message_end":
    case "turn_end":
    case "compaction_end":
    case "retry_end": {
      // A finished assistant message settles its items: the next turn's
      // reasoning must not append to the previous turn's assistant.
      const run = currentRun(state);
      for (const item of run?.items ?? []) item.streaming = false;
      break;
    }
    case "tool_execution_start": {
      const run = ensureRunningRun(state);
      // A task batch's shared brief rides the tool call: hoist it to the
      // panel so the fan-out's goal is visible while its agents run.
      if (event.toolName === "task") {
        const context = (event.input as { context?: unknown } | undefined)?.context;
        if (typeof context === "string" && context.trim()) state.fanoutGoal = context.trim();
      }
      const item: TranscriptItem = {
        kind: "tool",
        text: `${event.toolName}…`,
        streaming: true,
        startedAt: Date.now(),
      };
      if (event.input !== undefined) item.input = event.input;
      if (event.timeoutMs !== undefined) item.timeoutMs = event.timeoutMs;
      run.items.push(item);
      break;
    }
    case "tool_execution_end": {
      const run = currentRun(state);
      // Close the most recent streaming tool item.
      for (let i = run?.items.length ? run.items.length - 1 : -1; i >= 0; i--) {
        const item = run!.items[i]!;
        if (item.kind === "tool" && item.streaming) {
          item.streaming = false;
          item.text = `${event.toolName}`;
          if (item.startedAt !== undefined) item.durationMs = Date.now() - item.startedAt;
          if (event.result !== undefined) item.result = event.result;
          break;
        }
      }
      break;
    }
    case "tool_output": {
      const run = currentRun(state);
      // Append live output to the streaming tool item with the same callId.
      for (let i = run?.items.length ? run.items.length - 1 : -1; i >= 0; i--) {
        const item = run!.items[i]!;
        if (item.kind === "tool" && item.streaming && item.text.startsWith(event.toolName)) {
          item.output = `${item.output ?? ""}${event.text}`;
          break;
        }
      }
      break;
    }
    case "stream_rule_triggered": {
      const run = ensureRunningRun(state);
      // The interrupted partial assistant item will never settle on its
      // own (the retry opens a NEW item on message_start): settle it now.
      for (const item of run.items) {
        if (item.kind === "assistant") item.streaming = false;
      }
      run.items.push({
        kind: "status",
        text: `⚠ stream rule "${event.rule}" matched — discarding output, injecting reminder`,
        streaming: false,
      });
      break;
    }
    case "compaction_start": {
      const run = ensureRunningRun(state);
      run.items.push({ kind: "status", text: "compacting context…", streaming: false });
      break;
    }
    case "delegation_batch_started": {
      const run = ensureRunningRun(state);
      run.fanoutSource = event.source;
      // A `task` fan-out lives in the pinned panel: the transcript keeps only
      // the batch summary the panel cannot express lasting state for. Any
      // other source (workflow/script, or an unlabelled producer) keeps the
      // status line it has always had.
      if (event.source === "task") break;
      run.items.push({
        kind: "status",
        text: `delegating: ${event.label} (${event.agentCount} agents)`,
        streaming: false,
      });
      break;
    }
    case "delegation_agent_started": {
      // Live chrome (todo-style): one pinned line per agent, updated IN
      // PLACE. Never a transcript item per subagent tool call — and never a
      // transcript item at all until the agent settles.
      state.liveAgents.set(event.agentId, {
        agentId: event.agentId,
        label: event.label,
        text: `▶ ${event.label}`,
        startedAt: Date.now(),
      });
      break;
    }
    case "delegation_agent_event": {
      let line = state.liveAgents.get(event.agentId);
      if (!line) {
        // Agent started outside this view (resume): adopt a live line now.
        line = { agentId: event.agentId, label: event.label, text: `▶ ${event.label}` };
        state.liveAgents.set(event.agentId, line);
      }
      const inner = event.event;
      if (inner.type === "tool_execution_start") {
        line.text = `⚙ ${event.label} · ${inner.toolName}`;
        line.toolCalls = (line.toolCalls ?? 0) + 1;
      } else if (inner.type === "message_end") {
        // One completed assistant turn == one model request.
        line.requests = (line.requests ?? 0) + 1;
      } else if (inner.type === "message_update") {
        // Live answer text: tail-capped so a chatty subagent cannot balloon
        // the pinned line. A tool line resets; an answer line accumulates.
        const chunk = inner.text.replace(/\s+/g, " ").trim();
        if (chunk) {
          const answerPrefix = `▶ ${event.label}: `;
          const inAnswer = line.text.startsWith(answerPrefix) || line.text.endsWith("· live");
          const base = inAnswer ? line.text.replace(/ · live$/, "") : answerPrefix;
          line.text = `${base}${chunk} · live`.slice(-200);
        }
      }
      // message_end/turn_end/agent_end: keep the last activity text; the
      // terminal ✔/✘ marker lands via delegation_agent_completed.
      break;
    }
    case "delegation_agent_completed": {
      // Settle the chrome line IN PLACE (✓/✗ + error stays visible beside its
      // still-running peers). The transcript gets the markers as one block
      // when the batch completes — a lone ✗ landing mid-flight while its
      // siblings are still in the pinned panel reads as a split brain.
      let line = state.liveAgents.get(event.agentId);
      if (!line) {
        line = { agentId: event.agentId, label: event.label, text: `\u25b6 ${event.label}` };
        state.liveAgents.set(event.agentId, line);
      }
      line.outcome = { ok: event.ok, ...(event.error ? { error: event.error } : {}) };
      line.durationMs ??= line.startedAt !== undefined ? Date.now() - line.startedAt : undefined;
      // Token spend lands with the terminal event (usage is per-run).
      const usage = event.usage as
        | {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          }
        | undefined;
      if (usage) {
        const n = (v: unknown): number => (typeof v === "number" && v > 0 ? v : 0);
        line.tokens =
          n(usage.inputTokens) +
          n(usage.outputTokens) +
          n(usage.cacheReadTokens) +
          n(usage.cacheWriteTokens);
      }
      // task fan-out: the panel owns the verdict (see batch_completed).
      break;
    }
    case "delegation_batch_completed": {
      const run = ensureRunningRun(state);
      const settled = [...state.liveAgents.values()].filter((l) => l.outcome);
      if (run.fanoutSource === "task") {
        // The panel carried the detail live; the transcript keeps one compact
        // row per agent (omp's "Background job completed [task] <name>
        // (2m9s)"): a later reader sees WHICH agents ran and how long each
        // took, and failures keep their reason — without a third copy of the
        // output.
        for (const line of settled) {
          const ok = line.outcome?.ok === true;
          const mark = ok
            ? `${tuiTheme.success}\u2714\u001b[0m`
            : `${tuiTheme.error}\u2718\u001b[0m`;
          const took =
            line.durationMs !== undefined ? ` (${formatDurationMs(line.durationMs)})` : "";
          const reason = ok ? "" : `: ${line.outcome?.error ?? "failed"}`;
          run.items.push({
            kind: "status",
            text: `${mark} ${line.label}${took}${reason}`,
            streaming: false,
          });
        }
      } else {
        for (const line of settled) {
          run.items.push({
            kind: "status",
            text: line.outcome?.ok
              ? `  \u2714 ${line.label}`
              : `  \u2718 ${line.label}: ${line.outcome?.error ?? "failed"}`,
            streaming: false,
          });
        }
        run.items.push({
          kind: "status",
          text: `delegation done \u00b7 ${event.totalTokens} tokens`,
          streaming: false,
        });
      }
      state.liveAgents.clear();
      run.fanoutSource = undefined;
      state.fanoutGoal = undefined;
      break;
    }
    case "queue_update": {
      // pi's message_start(user): a steered message the loop actually
      // injected renders as a settled user item at the injection point —
      // after the tool items that ran before the drain.
      if (event.drained?.length) settleSteeredMessages(state, event.drained);
      break;
    }
    case "delegation_batch_failed": {
      const run = ensureRunningRun(state);
      const settled = [...state.liveAgents.values()].filter((l) => l.outcome);
      if (run.fanoutSource !== "task") {
        for (const line of settled) {
          run.items.push({
            kind: "status",
            text: line.outcome?.ok
              ? `  \u2714 ${line.label}`
              : `  \u2718 ${line.label}: ${line.outcome?.error ?? "failed"}`,
            streaming: false,
          });
        }
      }
      state.liveAgents.clear();
      run.fanoutSource = undefined;
      run.items.push({ kind: "error", text: `delegation: ${event.error}`, streaming: false });
      break;
    }
    case "agent_end": {
      const run = currentRun(state);
      if (run) run.running = false;
      // Settle all streaming items.
      for (const item of run?.items ?? []) item.streaming = false;
      break;
    }
    case "todo_update":
      // Todo is chrome-only: this snapshot drives the pinned panel above
      // the editor; todo tool calls render nothing in the transcript
      // (TuiItemRenderer.renderTool returns [] for them).
      state.todoItems = [...event.items];
      break;
    // queue/recap events: handled above / no v1 transcript rendering.
    default:
      break;
  }
}

/** Fold a terminal outcome into the view state. */
export function applyOutcome(state: TuiViewState, outcome: BackendRunOutcome): void {
  const run = currentRun(state);
  if (run) run.running = false;
  // A finished run cannot leave a fan-out panel behind: its goal goes with it
  // (the panel itself is driven by liveAgents, which the batch events clear).
  state.fanoutGoal = undefined;
  const runs = state.runs;
  if (outcome.status === "failed") {
    runs.push({
      items: [{ kind: "error", text: outcome.error ?? "run failed", streaming: false }],
      running: false,
    });
  } else if (outcome.status === "aborted") {
    runs.push({
      items: [{ kind: "status", text: "aborted", streaming: false }],
      running: false,
    });
  } else if (outcome.status === "completed" && outcome.workflow) {
    const value = JSON.stringify(outcome.workflow.value) ?? "undefined";
    runs.push({
      items: [
        {
          kind: "status",
          text: `workflow result: ${value.slice(0, 200)}${value.length > 200 ? "\u2026" : ""}`,
          streaming: false,
        },
      ],
      running: false,
    });
  }
}

/** Add the user's input echo to the transcript before a run starts.
 *  `pending` marks steered/queued injections (rendered dim with »). */
export function addUserInput(state: TuiViewState, text: string, pending = false): void {
  const item: TranscriptItem = { kind: "user", text, streaming: false };
  if (pending) item.pending = true;
  state.runs.push({ items: [item], running: false });
}

/** Rebuild the transcript view from a session's persisted messages
 *  (resume/fork). User/assistant text render like live items; tool_use and
 *  tool_result blocks are paired so resumed tool calls show args/output.
 *  Compacted summaries are already a user bubble in the session file. */
export function hydrateTranscript(
  state: TuiViewState,
  messages: readonly Record<string, unknown>[],
): void {
  const runs: RunViewState[] = [];
  const pendingTools: Array<{ id: string; item: TranscriptItem }> = [];

  for (const raw of messages) {
    const role = raw.role;
    const text = typeof raw.text === "string" ? raw.text : "";
    if (role === "user") {
      runs.push({ items: [{ kind: "user", text, streaming: false }], running: false });
      continue;
    }
    if (role === "assistant") {
      const blocks = Array.isArray(raw.blocks)
        ? (raw.blocks as Array<Record<string, unknown>>)
        : [];
      const items: TranscriptItem[] = [];
      const thinking = blocks
        .filter((b) => b.type === "thinking")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("\n");
      if (text) {
        const item: TranscriptItem = { kind: "assistant", text, streaming: false };
        if (thinking) item.thinking = thinking;
        items.push(item);
      } else if (thinking) {
        items.push({ kind: "assistant", text: "", streaming: false, thinking });
      }
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        const item: TranscriptItem = {
          kind: "tool",
          text: typeof b.name === "string" ? b.name : "",
          streaming: false,
        };
        if (b.input !== null && typeof b.input === "object") {
          item.input = b.input as Record<string, unknown>;
        }
        items.push(item);
        pendingTools.push({ id: String(b.id ?? ""), item });
      }
      if (items.length > 0) runs.push({ items, running: false });
      continue;
    }
    if (role === "tool") {
      const blocks = Array.isArray(raw.blocks)
        ? (raw.blocks as Array<Record<string, unknown>>)
        : [];
      let attached = false;
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const toolUseId = String(b.tool_use_id ?? "");
        const target = pendingTools.find((p) => p.id === toolUseId);
        const content = typeof b.content === "string" ? b.content : text;
        if (target) {
          attached = true;
          const result: Record<string, unknown> = { content };
          if (b.is_error === true) result.isError = true;
          target.item.result = result;
        } else if (content) {
          attached = true;
          runs.push({
            items: [
              {
                kind: "status",
                text: `tool result: ${content.slice(0, 120)}`,
                streaming: false,
              },
            ],
            running: false,
          });
        }
      }
      if (!attached && text) {
        runs.push({
          items: [
            {
              kind: "status",
              text: `tool result: ${text.slice(0, 120)}`,
              streaming: false,
            },
          ],
          running: false,
        });
      }
    }
  }
  state.runs = runs;
}

/** Settle pending » echoes whose messages the loop has now injected (pi
 * renders the user message when consumed, not when submitted). The pending
 * echo entry is removed and a settled user item is appended at the current
 * transcript position. Texts without a matching echo are ignored (e.g.
 * surface-injected steers this TUI never echoed). */
export function settleSteeredMessages(state: TuiViewState, texts: readonly string[]): void {
  for (const text of texts) {
    const idx = state.runs.findIndex(
      (r) =>
        !r.running &&
        r.items.length === 1 &&
        r.items[0]?.kind === "user" &&
        r.items[0]?.pending === true &&
        r.items[0]?.text === text,
    );
    if (idx < 0) continue;
    state.runs.splice(idx, 1);
    state.runs.push({ items: [{ kind: "user", text, streaming: false }], running: false });
  }
}

/** True while the last run is live (editor submits become steer). */
export function isRunLive(state: TuiViewState): boolean {
  return currentRun(state)?.running ?? false;
}

/** Goal-evaluator evidence: the transcript as bounded, one-line-per-item
 *  strings (most recent last). The evaluator judges ONLY what the agent
 *  surfaced, so tool RESULTS are the proof that matters ("tests pass"),
 *  while user/assistant text carries the thread. Runs that predate the
 *  goal are still evidence — the condition may already hold. */
export function transcriptEvidence(state: TuiViewState, maxItems = 40): string[] {
  const lines: string[] = [];
  for (const run of state.runs) {
    for (const item of run.items) {
      const clipped = (s: string): string => {
        const flat = s.replace(/\s+/g, " ").trim();
        return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
      };
      if (item.kind === "user") lines.push(`user: ${clipped(item.text)}`);
      else if (item.kind === "assistant" && item.text.trim())
        lines.push(`assistant: ${clipped(item.text)}`);
      else if (item.kind === "tool") {
        const content = item.result?.content;
        const result = typeof content === "string" ? clipped(content) : "(no result)";
        lines.push(`tool ${item.text.replace(/…$/, "")}: ${result}`);
      }
    }
  }
  return lines.slice(-maxItems);
}
