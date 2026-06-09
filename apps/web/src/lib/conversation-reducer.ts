import type { ContentBlock, Message } from "./api";

export type RunPhase = "idle" | "running" | "interrupted" | "done" | "error";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface DraftTool {
  id: string;
  name: string;
}

export interface Draft {
  runId: string;
  text: string;
  tools: DraftTool[];
}

export interface ConvState {
  messages: UiMessage[];
  draft: Draft | null;
  run: { id: string | null; phase: RunPhase };
  pendingInterrupt: { id: string; name: string; input: unknown } | null;
  error: string | null;
  optimisticSeq: number;
}

export type Action =
  | { type: "history/loaded"; messages: Message[] }
  | { type: "run/started"; runId: string }
  | { type: "send"; text: string }
  | { type: "stream/delta"; runId: string; blockIndex: number; text: string }
  | { type: "stream/toolStart"; id: string; name: string }
  | { type: "stream/toolEnd"; id: string }
  | { type: "events/message"; seq: number | null; msg: { role: string; content: unknown } }
  | { type: "events/interrupted"; payload: { pendingTool?: { id: string; name: string; input: unknown } } }
  | { type: "events/error"; message: string }
  | { type: "events/done" }
  | { type: "run/completed" }
  | { type: "run/error" };

export function initialState(): ConvState {
  return {
    messages: [],
    draft: null,
    run: { id: null, phase: "idle" },
    pendingInterrupt: null,
    error: null,
    optimisticSeq: 0,
  };
}

function upsertAuthoritative(
  list: UiMessage[],
  id: string,
  role: "user" | "assistant",
  content: string | ContentBlock[],
): UiMessage[] {
  const idx = list.findIndex((m) => m.id === id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = { id, role, content };
    return next;
  }
  // User echo: replace optimistic user message
  if (role === "user") {
    const optIdx = [...list]
      .reverse()
      .findIndex((m) => m.id.startsWith("opt-") && m.role === "user");
    if (optIdx >= 0) {
      const real = list.length - 1 - optIdx;
      const next = [...list];
      next[real] = { id, role, content };
      return next;
    }
  }
  return [...list, { id, role, content }];
}

function norm(c: unknown): string | ContentBlock[] {
  return typeof c === "string" ? c : (c as ContentBlock[]);
}

export function reducer(s: ConvState, a: Action): ConvState {
  switch (a.type) {
    case "history/loaded": {
      const messages = a.messages
        .filter(
          (m): m is Message & { role: "user" | "assistant" } =>
            m.role !== "system",
        )
        .map((m, i) => ({ id: `h-${i}`, role: m.role, content: m.content }));
      return { ...s, messages };
    }

    case "run/started":
      return { ...s, run: { id: a.runId, phase: "running" }, error: null };

    case "send": {
      const id = `opt-${s.optimisticSeq}`;
      return {
        ...s,
        optimisticSeq: s.optimisticSeq + 1,
        run: { ...s.run, phase: "running" },
        messages: [...s.messages, { id, role: "user", content: a.text }],
      };
    }

    case "stream/delta":
      return {
        ...s,
        draft: {
          runId: a.runId,
          tools: s.draft?.tools ?? [],
          text: (s.draft?.text ?? "") + a.text,
        },
      };

    case "stream/toolStart":
      return {
        ...s,
        draft: {
          runId: s.draft?.runId ?? s.run.id ?? "",
          text: s.draft?.text ?? "",
          tools: [
            ...(s.draft?.tools ?? []),
            { id: a.id, name: a.name },
          ],
        },
      };

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

    case "events/message": {
      const role = a.msg.role;
      if (role !== "user" && role !== "assistant") return s;
      const id =
        a.seq !== null ? `s-${a.seq}` : `s-${s.messages.length}`;
      const messages = upsertAuthoritative(
        s.messages,
        id,
        role,
        norm(a.msg.content),
      );
      // ★ Atomic: authoritative assistant arrival clears draft
      return role === "assistant"
        ? { ...s, messages, draft: null }
        : { ...s, messages };
    }

    case "events/interrupted":
      return {
        ...s,
        pendingInterrupt: a.payload.pendingTool ?? null,
        run: { ...s.run, phase: "interrupted" },
        draft: null,
      };

    case "events/error":
      return {
        ...s,
        error: a.message,
        run: { ...s.run, phase: "error" },
        draft: null,
      };

    case "events/done":
    case "run/completed":
      if (s.run.phase === "interrupted" || s.run.phase === "error") {
        return { ...s, draft: null };
      }
      return { ...s, draft: null, run: { ...s.run, phase: "done" } };

    case "run/error":
      return { ...s, run: { ...s.run, phase: "error" }, draft: null };

    default:
      return s;
  }
}
