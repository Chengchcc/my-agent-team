import type { ContentBlock } from "./api";

export type RunPhase = "idle" | "running" | "interrupted" | "done" | "error";

export interface SenderRef {
  memberId: string;
  kind: "agent" | "human" | "system";
  displayName?: string;
}

export interface UiMessage {
  id: string;
  sender: SenderRef;
  content: string | ContentBlock[];
}

export interface DraftTool {
  id: string;
  name: string;
}

export interface Draft {
  runId: string;
  agentMemberId: string;
  sender: SenderRef;
  text: string;
  tools: DraftTool[];
}

export type TriggerMode = "auto" | "mention";

export interface ConvState {
  viewerMemberId: string;
  roster: Record<string, SenderRef>;
  messages: UiMessage[];
  draft: Draft | null;
  run: { id: string | null; phase: RunPhase; agentMemberId: string | null };
  pendingInterrupt: { id: string; name: string; input: unknown } | null;
  error: string | null;
  optimisticSeq: number;
  triggerMode: TriggerMode;
  /** M14.6: Task todo progress — full snapshot from todo_update events. */
  todos: Array<{ step: string; status: "pending" | "in_progress" | "done" }>;
}

export type Action =
  | { type: "bootstrap"; viewerMemberId: string; members: SenderRef[] }
  | { type: "ledger/member"; seq: number; kind: "member.joined" | "member.left"; payload: unknown }
  | { type: "ledger/message"; seq: number; senderMemberId: string; content: unknown }
  | { type: "send"; text: string; viewer: SenderRef }
  | { type: "run/started"; runId: string; agentMemberId: string }
  | { type: "stream/delta"; runId: string; agentMemberId: string; blockIndex: number; text: string }
  | { type: "stream/toolStart"; id: string; name: string }
  | { type: "stream/toolEnd"; id: string }
  | {
      type: "run/interrupted";
      payload: { pendingTool?: { id: string; name: string; input: unknown } };
    }
  | { type: "run/error"; message: string }
  | { type: "run/done" }
  | { type: "run/completed" }
  | { type: "toggleTriggerMode" }
  | { type: "todo/update"; todos: ConvState["todos"] };

export function initialState(): ConvState {
  return {
    viewerMemberId: "",
    roster: {},
    messages: [],
    draft: null,
    run: { id: null, phase: "idle", agentMemberId: null },
    pendingInterrupt: null,
    error: null,
    optimisticSeq: 0,
    triggerMode: "auto",
    todos: [],
  };
}

function norm(c: unknown): string | ContentBlock[] {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c as ContentBlock[];
  // Defense-in-depth: unwrap { text: "..." } from legacy agent message payloads
  if (
    typeof c === "object" &&
    c !== null &&
    "text" in c &&
    typeof (c as { text: unknown }).text === "string"
  ) {
    return (c as { text: string }).text;
  }
  return String(c);
}

function upsertAuthoritative(
  list: UiMessage[],
  id: string,
  sender: SenderRef,
  content: string | ContentBlock[],
  viewerMemberId: string,
): UiMessage[] {
  const idx = list.findIndex((m) => m.id === id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = { id, sender, content };
    return next;
  }
  // Self echo: replace optimistic self message (was "role === user")
  if (sender.memberId === viewerMemberId) {
    const optIdx = [...list]
      .reverse()
      .findIndex((m) => m.id.startsWith("opt-") && m.sender.memberId === viewerMemberId);
    if (optIdx >= 0) {
      const real = list.length - 1 - optIdx;
      const next = [...list];
      next[real] = { id, sender, content };
      return next;
    }
  }
  return [...list, { id, sender, content }];
}

// ─── M14.5: Turn grouping (pure render-layer selector) ───

export type TurnSegment =
  | { kind: "single"; message: UiMessage }
  | {
      kind: "turn";
      id: string;
      sender: SenderRef;
      rounds: UiMessage[];
      conclusion: UiMessage | null;
    };

/** A message is a "conclusion" if it has text content AND no tool_use blocks.
 *  Tool_result-only messages (has tool_result but no text) are NOT conclusions. */
export function isConclusionMessage(m: UiMessage): boolean {
  if (typeof m.content === "string") return m.content.trim().length > 0;
  const blocks = m.content;
  const hasToolUse = blocks.some((b) => b.type === "tool_use");
  const hasText = blocks.some(
    (b) =>
      b.type === "text" &&
      typeof (b as { text?: string }).text === "string" &&
      (b as { text: string }).text.trim().length > 0,
  );
  return !hasToolUse && hasText;
}

/** Group flat messages into turn segments by continuous same-agent sender. */
export function groupTurns(messages: UiMessage[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.sender.kind !== "agent") {
      out.push({ kind: "single", message: m });
      i++;
      continue;
    }
    // Collect continuous same-agent block
    const start = i;
    while (
      i < messages.length &&
      messages[i]?.sender.kind === "agent" &&
      messages[i]?.sender.memberId === m.sender.memberId
    )
      i++;
    const block = messages.slice(start, i);
    // Find last conclusion within the block
    let lastConclusionIdx = -1;
    for (let k = block.length - 1; k >= 0; k--) {
      if (isConclusionMessage(block[k]!)) {
        lastConclusionIdx = k;
        break;
      }
    }
    const conclusion = lastConclusionIdx >= 0 ? block[lastConclusionIdx]! : null;
    const rounds = block.filter((_, k) => k !== lastConclusionIdx);
    out.push({ kind: "turn", id: block[0]!.id, sender: m.sender, rounds, conclusion });
  }
  return out;
}

export function reducer(s: ConvState, a: Action): ConvState {
  switch (a.type) {
    case "bootstrap": {
      const roster: Record<string, SenderRef> = {
        __system__: { memberId: "__system__", kind: "system" },
      };
      for (const m of a.members) roster[m.memberId] = m;
      const agentCount = Object.values(roster).filter((m) => m.kind === "agent").length;
      return {
        ...s,
        viewerMemberId: a.viewerMemberId,
        roster,
        triggerMode: agentCount > 1 ? "mention" : "auto",
      };
    }

    case "ledger/member": {
      const payload = a.payload as {
        members?: Array<{
          memberId: string;
          kind: "agent" | "human";
          displayName?: string;
        }>;
      };
      const roster = { ...s.roster };
      for (const m of payload.members ?? []) roster[m.memberId] = { ...m };
      // Drop a system notice for the member event
      const id = `s-${a.seq}`;
      const sender: SenderRef = {
        memberId: "__system__",
        kind: "system",
      };
      const verb = a.kind === "member.joined" ? "加入" : "离开";
      const present = (payload.members ?? [])
        .map((m) => roster[m.memberId]?.displayName ?? m.memberId)
        .join(", ");
      const messages = upsertAuthoritative(
        s.messages,
        id,
        sender,
        `[系统] 成员变化：${verb}。当前在场：${present}`,
        s.viewerMemberId,
      );
      return { ...s, roster, messages };
    }

    case "ledger/message": {
      const id = `s-${a.seq}`;
      const sender = s.roster[a.senderMemberId] ?? {
        memberId: a.senderMemberId,
        kind: "agent" as const,
      };
      const messages = upsertAuthoritative(
        s.messages,
        id,
        sender,
        norm(a.content),
        s.viewerMemberId,
      );
      // Clear draft if: self message arrives, or current draft's agent message arrives
      const clearsDraft =
        sender.memberId === s.viewerMemberId ||
        (s.draft !== null && a.senderMemberId === s.draft.agentMemberId);
      return clearsDraft ? { ...s, messages, draft: null } : { ...s, messages };
    }

    case "send": {
      const id = `opt-${s.optimisticSeq}`;
      return {
        ...s,
        optimisticSeq: s.optimisticSeq + 1,
        run: { ...s.run, phase: "running" },
        messages: [...s.messages, { id, sender: a.viewer, content: a.text }],
      };
    }

    case "run/started":
      return {
        ...s,
        run: { id: a.runId, phase: "running", agentMemberId: a.agentMemberId },
        error: null,
      };

    case "stream/delta": {
      const sender = s.roster[a.agentMemberId] ?? {
        memberId: a.agentMemberId,
        kind: "agent" as const,
      };
      const sameRun = a.runId === s.draft?.runId;
      const carryText = sameRun ? (s.draft?.text ?? "") : "";
      const carryTools = sameRun ? (s.draft?.tools ?? []) : [];
      return {
        ...s,
        draft: {
          runId: a.runId,
          agentMemberId: a.agentMemberId,
          sender,
          tools: carryTools,
          text: carryText + a.text,
        },
      };
    }

    case "stream/toolStart": {
      // When tool_start arrives before first text_delta, seed a minimal draft
      if (s.draft) {
        return {
          ...s,
          draft: {
            ...s.draft,
            tools: [...s.draft.tools, { id: a.id, name: a.name }],
          },
        };
      }
      const runId = s.run.id;
      const agentMemberId = s.run.agentMemberId;
      if (!runId || !agentMemberId) return s; // no active run context, drop
      const sender = s.roster[agentMemberId] ?? {
        memberId: agentMemberId,
        kind: "agent" as const,
      };
      return {
        ...s,
        draft: {
          runId,
          agentMemberId,
          sender,
          text: "",
          tools: [{ id: a.id, name: a.name }],
        },
      };
    }

    case "stream/toolEnd":
      return s.draft
        ? {
            ...s,
            draft: {
              ...s.draft,
              tools: s.draft.tools.filter((t) => t.id !== a.id),
            },
          }
        : s;

    case "run/interrupted":
      return {
        ...s,
        pendingInterrupt: a.payload.pendingTool ?? null,
        run: { ...s.run, phase: "interrupted" },
        draft: null,
      };

    case "run/error":
      return {
        ...s,
        error: a.message,
        run: { ...s.run, phase: "error" },
        draft: null,
      };

    case "run/done":
    case "run/completed":
      if (s.run.phase === "interrupted" || s.run.phase === "error") {
        return { ...s, draft: null };
      }
      return { ...s, draft: null, run: { ...s.run, phase: "done" } };

    case "toggleTriggerMode":
      return {
        ...s,
        triggerMode: s.triggerMode === "auto" ? "mention" : "auto",
      };

    case "todo/update":
      // Full snapshot replacement — latest arrival is authoritative
      return { ...s, todos: a.todos };

    default:
      return s;
  }
}
