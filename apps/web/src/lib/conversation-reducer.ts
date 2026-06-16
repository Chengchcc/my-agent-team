import type { Message, MessageRevision } from "@my-agent-team/message";
import { mergeMessageRevision, parseMessageRevision } from "@my-agent-team/message";

// ─── Types ────────────────────────────────────────────────

export interface SenderRef {
  memberId: string;
  kind: "agent" | "human" | "system";
  displayName?: string;
}

export interface UiMessage {
  id: string;
  sender: SenderRef;
  content: Message;
}

export type TriggerMode = "auto" | "mention";
export type LedgerConn = "connecting" | "open" | "reconnecting" | "closed";

export interface ConvState {
  viewerMemberId: string;
  roster: Record<string, SenderRef>;
  messages: UiMessage[];
  ledgerConn: LedgerConn;
  error: string | null;
  optimisticSeq: number;
  triggerMode: TriggerMode;
  /** M14.6: Task todo progress — full snapshot from todo_update events. */
  todos: Array<{ step: string; status: "pending" | "in_progress" | "done" }>;
  /** M17: Number of sends that have been dispatched locally but not yet
   *  confirmed by the backend (POST in-flight). Cleared when the first
   *  authoritative agent revision arrives or on send error. */
  pendingSendCount: number;
}

export type Action =
  | { type: "bootstrap"; viewerMemberId: string; members: SenderRef[] }
  | { type: "ledger/member"; seq: number; kind: "member.joined" | "member.left"; payload: unknown }
  | { type: "ledger/message"; seq: number; senderMemberId: string; content: unknown }
  | { type: "send"; text: string; viewer: SenderRef }
  | { type: "ledger/conn"; status: LedgerConn }
  | { type: "toggleTriggerMode" }
  | { type: "send/error"; message: string }
  | { type: "todo/update"; todos: ConvState["todos"] };

export function initialState(): ConvState {
  return {
    viewerMemberId: "",
    roster: {},
    messages: [],
    ledgerConn: "connecting",
    error: null,
    optimisticSeq: 0,
    triggerMode: "auto",
    todos: [],
    pendingSendCount: 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────

/** Whether there is an open (not done/error) assistant message
 *  that means the UI should show a busy state. */
export function isBusy(s: ConvState): boolean {
  if (s.pendingSendCount > 0) return true;
  return s.messages.some(
    (m) =>
      m.sender.kind === "agent" &&
      (m.content.state === "streaming" || m.content.state === "waiting"),
  );
}

/** M17: Extract pending approval from a waiting revision for ToolApprovalCard. */
export function getApprovalTarget(s: ConvState): {
  messageId: string;
  runId: string;
  text: string;
  tools: Array<{ id: string; name: string }>;
} | null {
  for (const m of s.messages) {
    if (m.sender.kind === "agent" && m.content.state === "waiting" && m.content.runId) {
      return {
        messageId: m.content.id ?? "",
        runId: m.content.runId,
        text: m.content.text ?? "",
        tools: (m.content.tools ?? [])
          .filter((t: { state: string }) => t.state === "running")
          .map((t: { id: string; name: string }) => ({ id: t.id, name: t.name })),
      };
    }
  }
  return null;
}

function upsertAuthoritative(
  list: UiMessage[],
  id: string,
  sender: SenderRef,
  content: Message,
  viewerMemberId: string,
): UiMessage[] {
  const idx = list.findIndex((m) => m.id === id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = { id, sender, content };
    return next;
  }
  // Self echo: replace optimistic self message
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

// ─── Turn Grouping (pure render-layer) ─────────────────────

export type TurnSegment =
  | { kind: "single"; message: UiMessage }
  | {
      kind: "turn";
      id: string;
      sender: SenderRef;
      rounds: UiMessage[];
      conclusion: UiMessage | null;
    };

export function isConclusionMessage(m: UiMessage): boolean {
  const text = m.content.text ?? "";
  const blocks = m.content.blocks;
  if (text.trim().length > 0) return true;
  if (!blocks || blocks.length === 0) return false;
  const hasToolUse = blocks.some((b: { type: string }) => b.type === "tool_use");
  const hasText = blocks.some(
    (b: { type: string; text?: string }) =>
      b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
  );
  return !hasToolUse && hasText;
}

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
    const start = i;
    while (
      i < messages.length &&
      messages[i]?.sender.kind === "agent" &&
      messages[i]?.sender.memberId === m.sender.memberId
    )
      i++;
    const block = messages.slice(start, i);
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

// ─── Reducer ───────────────────────────────────────────────

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
      const id = `s-${a.seq}`;
      const sender: SenderRef = { memberId: "__system__", kind: "system" };
      const verb = a.kind === "member.joined" ? "加入" : "离开";
      const present = (payload.members ?? [])
        .map((m) => roster[m.memberId]?.displayName ?? m.memberId)
        .join(", ");
      const messages = upsertAuthoritative(
        s.messages,
        id,
        sender,
        { id, role: "system" as const, state: "done" as const, text: `[系统] 成员变化：${verb}。当前在场：${present}` },
        s.viewerMemberId,
      );
      return { ...s, roster, messages };
    }

    case "ledger/message": {
      const revision = parseMessageRevision(a.content);
      const message = mergeMessageRevision(null, revision);
      const id = message.id ?? "";
      const sender = s.roster[a.senderMemberId] ?? {
        memberId: a.senderMemberId,
        kind: "agent" as const,
      };
      const messages = upsertAuthoritative(s.messages, id, sender, message, s.viewerMemberId);
      // First agent message confirms the POST — clear pending send count
      const cleared = sender.kind === "agent" && s.pendingSendCount > 0 ? 0 : s.pendingSendCount;
      return { ...s, messages, pendingSendCount: cleared };
    }

    case "send": {
      const id = `opt-${s.optimisticSeq}`;
      return {
        ...s,
        optimisticSeq: s.optimisticSeq + 1,
        pendingSendCount: s.pendingSendCount + 1,
        messages: [
          ...s.messages,
          {
            id,
            sender: a.viewer,
            content: { id, role: "user" as const, state: "done" as const, text: a.text },
          },
        ],
      };
    }

    case "ledger/conn":
      return { ...s, ledgerConn: a.status };

    case "send/error":
      return {
        ...s,
        error: a.message,
        pendingSendCount: Math.max(0, s.pendingSendCount - 1),
      };

    case "toggleTriggerMode":
      return { ...s, triggerMode: s.triggerMode === "auto" ? "mention" : "auto" };

    case "todo/update":
      return { ...s, todos: a.todos };

    default:
      return s;
  }
}
