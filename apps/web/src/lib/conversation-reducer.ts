import type { Message, MessageRevision } from "@chengchenccc/message";
import { extractText, mergeMessageRevision } from "@chengchenccc/message";

// ─── Types ────────────────────────────────────────────────

/** Mirrors the backend Member payload (cut-2 will collapse this to agent info).
 *  System notices (member join/leave) are NOT messages — they are UiItems of kind "notice". */
export interface SenderRef {
  memberId: string;
  kind: "agent" | "human";
  displayName?: string;
  /** Agent identifier — present for agent members, used for per-agent coloring. */
  agentId?: string;
}

export type UiItem =
  | {
      kind: "message";
      id: string;
      sender: SenderRef;
      content: Message;
      /** Ledger seq - needed for fork/undo/replay targeting. */
      seq: number;
      /** Soft-delete flag - greyed out when true. */
      undone?: boolean;
      /** Anchored comment (raft absorption): renders as a jump chip. */
      anchor?: { url: string; anchor: unknown };
    }
  | { kind: "notice"; id: string; text: string };

/** "message" variant of UiItem — derived, not a new domain concept. */
export type MessageItem = Extract<UiItem, { kind: "message" }>;

export type StreamConn = "connecting" | "open" | "reconnecting" | "closed";

/** The control fact a continuation carries (#30): the conversation moved —
 *  surfaces rebind to the new one instead of showing a text notice and
 *  staying subscribed to the old live owner. */
export interface SurfaceControl {
  readonly type: "rebind_conversation";
  readonly conversationId: string;
  readonly requestedByRunId: string;
}

export interface ConvState {
  /** The conversation's agent (1:1 collapse; the human is the viewer). */
  agent: SenderRef | null;
  /** The AHP projection's items — REPLACED wholesale on every state (#29).
   *  An item the projection no longer contains is gone: upserting here kept
   *  ghosts alive after undo/continuity/reconnect. */
  canonical: UiItem[];
  /** Local-only items (optimistic sends, pre-projection echoes); an entry
   *  collapses the moment canonical carries its id. */
  overlay: UiItem[];
  /** Rendered = canonical ∪ overlay. Derived — never written directly. */
  items: UiItem[];
  /** Pending control from the AHP state (#30). `live` means it arrived as a
   *  live action — only those auto-rebind; a control already in the initial
   *  snapshot is a historical hint, rendered as a "continue to" link (#48). */
  continuation: { control: SurfaceControl; live: boolean } | null;
  streamConn: StreamConn;
  error: string | null;
  /** Number of sends that have been dispatched locally but not yet settled
   *  by the backend (HTTP POST in-flight). Decremented on mutation
   *  onSettled (success OR error) - never tied to an agent reply; Run
   *  activity is tracked separately in the hook's activeRuns set. */
  pendingSendCount: number;
  /** W7: Monotonic sequence number for client-generated message IDs. */
  optimisticSeq: number;
}

export type Action =
  | { type: "bootstrap"; agent: SenderRef }
  | { type: "send"; text: string; viewer: SenderRef }
  /** POST settled (success OR error): decrement the in-flight counter. */
  | { type: "send/settled" }
  | { type: "conn"; status: StreamConn }
  | { type: "continuation"; control: SurfaceControl; live: boolean }
  | { type: "send/error"; message: string }
  | { type: "member"; seq: number; kind: string; payload: unknown }
  | {
      /** A settled message from the conversation's timeline.
       *  role is the authorship discriminator: user → viewer side,
       *  assistant/tool → agent side, system → notice item. */
      type: "message";
      seq: number;
      message: MessageRevision;
      /** Soft-delete flag from ledger entry (absent = live). */
      undone?: boolean;
    }
  | {
      type: "undo";
      undoneSeqs: number[];
    }
  /** The history as AHP state has it (ADR 0040): authoritative, and re-derived on every change. */
  | {
      type: "items";
      items: UiItem[];
    };

export function initialState(): ConvState {
  return {
    agent: null,
    canonical: [],
    overlay: [],
    items: [],
    continuation: null,
    streamConn: "connecting",
    error: null,
    pendingSendCount: 0,
    optimisticSeq: 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────

/** Whether there is an open (not done/error) assistant message
 *  that means the UI should show a busy state. */
/** Busy = a send is in flight or messages are queued locally. Execution
 *  state itself comes from Agent Runs (active run set in the hook layer). */
/** Busy = a send is in flight. Execution state itself comes from Agent
 *  Runs (active run set in the hook layer). */
export function isBusy(s: ConvState): boolean {
  return s.pendingSendCount > 0;
}

/** Role → sender. role is the authorship discriminator on the wire:
 *  user → the viewer (human); assistant/tool → the conversation's agent;
 *  (system never reaches here — the reducer turns it into a notice). */
function senderForRole(role: MessageRevision["role"], s: ConvState): SenderRef {
  if (role === "user") return { memberId: "user", kind: "human" };
  return s.agent ?? { memberId: "agent", kind: "agent" };
}

function upsertAuthoritative(list: UiItem[], item: MessageItem): UiItem[] {
  const { id, sender } = item;
  const idx = list.findIndex((existing) => existing.kind === "message" && existing.id === id);
  if (idx >= 0) {
    const next = [...list];
    const prev = next[idx]!;
    next[idx] = {
      ...item,
      undone: item.undone ?? (prev.kind === "message" ? prev.undone : undefined),
    };
    return next;
  }
  // Self echo: replace the latest optimistic self message (user role)
  if (sender.kind === "human") {
    const optIdx = [...list]
      .reverse()
      .findIndex((existing) => existing.kind === "message" && existing.id.startsWith("opt-"));
    if (optIdx >= 0) {
      const real = list.length - 1 - optIdx;
      const next = [...list];
      next[real] = item;
      return next;
    }
  }
  return [...list, item];
}

// ─── Turn Grouping (pure render-layer) ─────────────────────

export type TurnSegment =
  | { kind: "single"; item: MessageItem }
  | { kind: "notice"; text: string; id: string }
  | {
      kind: "turn";
      id: string;
      sender: SenderRef;
      rounds: MessageItem[];
      conclusion: MessageItem | null;
    };

export function isConclusionMessage(m: MessageItem): boolean {
  // Tool results are working rounds, never conclusions (ADR 0017): the
  // canonical ledger keeps them as separate `tool` messages carrying a
  // JSON text payload — without this guard they'd be classified as a
  // final conclusion and rendered as a bubble.
  if (m.content.role === "tool") return false;
  const blocks = m.content.blocks;
  // A round that issued a tool call is a working round, not the conclusion —
  // even when the model interleaved narrative text with the tool_use.
  const hasToolUse = blocks?.some((b: { type: string }) => b.type === "tool_use") ?? false;
  if (hasToolUse) return false;
  const text = extractText({ text: m.content.text, blocks });
  if (text.trim().length > 0) return true;
  if (!blocks || blocks.length === 0) return false;
  // A pure thinking-only skeleton (empty text, no tool_use) is a tool-round
  // scaffold, not a conclusion — claiming the conclusion slot inflates the
  // headline count by one and hides the real final answer.
  return blocks.some((b: { type: string }) => b.type !== "thinking");
}

export function groupTurns(items: UiItem[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind === "notice") {
      out.push({ kind: "notice", text: item.text, id: item.id });
      i++;
      continue;
    }
    if (item.sender.kind !== "agent") {
      out.push({ kind: "single", item });
      i++;
      continue;
    }
    const start = i;
    while (i < items.length) {
      // i < items.length guarantees items[i] is defined
      const cur = items[i]!;
      if (
        cur.kind !== "message" ||
        cur.sender.kind !== "agent" ||
        cur.sender.memberId !== item.sender.memberId
      )
        break;
      i++;
    }
    const block = items.slice(start, i).filter((x): x is MessageItem => x.kind === "message");
    let lastConclusionIdx = -1;
    for (let k = block.length - 1; k >= 0; k--) {
      if (isConclusionMessage(block[k]!)) {
        lastConclusionIdx = k;
        break;
      }
    }
    const conclusion = lastConclusionIdx >= 0 ? block[lastConclusionIdx]! : null;
    const rounds = block.filter((_, k) => k !== lastConclusionIdx);
    out.push({ kind: "turn", id: block[0]!.id, sender: item.sender, rounds, conclusion });
  }
  return out;
}

/** Whether segment `i` starts a new turn. System notices never start turns;
 *  in human-led conversations only human messages do. The sender-change
 *  fallback applies ONLY to pure agent conversations (no human segment),
 *  so member-joined notices can't fabricate turn numbers. */
export function isTurnStart(segments: TurnSegment[], i: number): boolean {
  const seg = segments[i]!;
  if (seg.kind === "notice") return false;
  const sender = segmentSenderOf(seg);
  if (sender.kind === "human") return true;
  const hasHuman = segments.some((s) => s.kind !== "notice" && segmentSenderOf(s).kind === "human");
  if (hasHuman) return false;
  if (i === 0) return true;
  const prevSender = segmentSenderOf(segments[i - 1]!);
  return prevSender.memberId !== sender.memberId;
}

function segmentSenderOf(seg: TurnSegment): SenderRef {
  if (seg.kind === "turn") return seg.sender;
  if (seg.kind === "single") return seg.item.sender;
  return { kind: "agent", memberId: "" }; // notice (never queried: filtered above)
}

// ─── Reducer ───────────────────────────────────────────────

/** Derive the rendered list: canonical wholesale, plus overlay entries the
 *  projection has not echoed yet (same id = the echo won, overlay goes). */
function reconcile(state: ConvState): ConvState {
  const canonicalIds = new Set(state.canonical.map((item) => item.id));
  // The optimistic send's id (opt-…) never equals its echo's (the ledger's
  // messageId), so id-collision alone cannot collapse it: a committed user
  // turn in canonical IS the echo. Bursts collapse together on the first
  // echo — the same one-beat imprecision the old latest-opt rule had.
  const echoed = state.canonical.some(
    (item) => item.kind === "message" && item.sender.kind === "human",
  );
  const overlay = state.overlay.filter((item) => {
    if (
      item.kind === "message" &&
      item.id.startsWith("opt-") &&
      item.sender.kind === "human" &&
      echoed
    ) {
      return false;
    }
    return !canonicalIds.has(item.id);
  });
  // Render order: an un-echoed send precedes the reply it provoked (the
  // canvas showed [opt, agent] before; canonical-first would flip it), while
  // notices and anything else append.
  const items = [...state.canonical];
  const firstAgentIdx = items.findIndex(
    (item) => item.kind === "message" && item.sender.kind === "agent",
  );
  for (const item of overlay) {
    if (item.kind === "message" && item.sender.kind === "human" && firstAgentIdx >= 0) {
      items.splice(firstAgentIdx, 0, item);
    } else {
      items.push(item);
    }
  }
  return { ...state, overlay, items };
}

export function reducer(s: ConvState, a: Action): ConvState {
  switch (a.type) {
    case "bootstrap": {
      // A new conversation's state starts fresh: the previous control is gone.
      return { ...s, agent: a.agent, continuation: null };
    }
    case "continuation":
      return { ...s, continuation: { control: a.control, live: a.live } };
    case "message": {
      const revision = a.message;
      // System authorship renders as a notice, not a chat bubble.
      if (revision.role === "system") {
        const text = extractText({ text: revision.text, blocks: revision.blocks });
        return reconcile({
          ...s,
          overlay: [
            ...s.overlay,
            { kind: "notice", id: revision.messageId, text: text || "[system]" },
          ],
        });
      }
      const existing = s.overlay.find(
        (it): it is Extract<UiItem, { kind: "message" }> =>
          it.kind === "message" && it.id === revision.messageId,
      );
      const message = mergeMessageRevision(existing?.content ?? null, revision);
      const id = message.id ?? revision.messageId;
      const sender = senderForRole(revision.role, s);
      const overlay = upsertAuthoritative(s.overlay, {
        kind: "message",
        id,
        sender,
        content: message,
        seq: a.seq,
        ...(existing?.anchor ? { anchor: existing.anchor } : {}),
        ...(a.undone ? { undone: true } : {}),
      });
      // pendingSendCount tracks ONLY the HTTP POST in flight (see
      // send/settled); an agent reply must not fake-clear it. The echo rides
      // the overlay; reconcile drops it once canonical carries the id.
      return reconcile({ ...s, overlay });
    }

    case "undo": {
      // Soft-delete: mark messages with seq in undoneSeqs as undone (greyed out).
      const undoSet = new Set(a.undoneSeqs);
      const mark = (item: UiItem) =>
        item.kind === "message" && undoSet.has(item.seq) ? { ...item, undone: true } : item;
      return reconcile({
        ...s,
        canonical: s.canonical.map(mark),
        overlay: s.overlay.map(mark),
      });
    }
    case "items": {
      // AHP owns the history and re-derives all of it on every change. Each item goes through the
      // same upsert the event path used: one that matches an existing item is updated in place,
      // and the ledger's echo of the viewer's own message replaces the optimistic item rather than
      // appearing beside it.
      // Wholesale replace (#29): the projection is authoritative for what
      // exists. The optimistic send survives in the overlay until its echo
      // lands here with the ledger's id.
      return reconcile({ ...s, canonical: [...a.items] });
    }
    case "send": {
      // W7: use stable UUID instead of opt- prefix — enables precise matching
      // when backend echoes the message back (future: clientMsgId in API).
      const id = `opt-${crypto.randomUUID()}`;
      return reconcile({
        ...s,
        pendingSendCount: s.pendingSendCount + 1,
        overlay: [
          ...s.overlay,
          {
            kind: "message" as const,
            id,
            sender: a.viewer,
            content: { id, role: "user" as const, state: "done" as const, text: a.text },
            seq: -1, // ponytail: sentinel - replaced when backend echoes authoritative seq
          },
        ],
      });
    }

    case "conn":
      return { ...s, streamConn: a.status };

    case "send/settled":
      return {
        ...s,
        pendingSendCount: Math.max(0, s.pendingSendCount - 1),
      };

    case "send/error":
      return {
        ...s,
        error: a.message,
      };

    default:
      return s;
  }
}
