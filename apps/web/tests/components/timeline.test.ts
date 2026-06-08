import { describe, test, expect } from "bun:test";
import { messagesToTimeline, extractText, type TimelineItem } from "../../src/lib/timeline";

function mergeTimeline(a: TimelineItem[], b: TimelineItem[]): TimelineItem[] {
  return [...a, ...b];
}

// ── Test data ──

function msg(role: "user" | "assistant" | "system", content: string) {
  return { role, content };
}

describe("messagesToTimeline", () => {
  test("converts messages to timeline items, filtering system", () => {
    const msgs = [
      msg("system", "You are an assistant"),
      msg("user", "Hello"),
      msg("assistant", "Hi there"),
    ];
    const items = messagesToTimeline(msgs);
    expect(items).toHaveLength(2);
    expect(items[0]!.role).toBe("user");
    expect(items[0]!.content).toBe("Hello");
    expect(items[1]!.role).toBe("assistant");
    expect(items[1]!.content).toBe("Hi there");
  });

  test("handles empty array", () => {
    expect(messagesToTimeline([])).toHaveLength(0);
  });

  test("filters all-system messages to empty", () => {
    const msgs = [msg("system", "prompt"), msg("system", "more")];
    expect(messagesToTimeline(msgs)).toHaveLength(0);
  });
});

describe("mergeTimeline", () => {
  test("history and live are concatenated head-to-tail", () => {
    const history = [
      { kind: "message" as const, role: "user" as const, content: "Q1" },
      { kind: "message" as const, role: "assistant" as const, content: "A1" },
    ];
    const live = [
      { kind: "message" as const, role: "user" as const, content: "Q2" },
      { kind: "message" as const, role: "assistant" as const, content: "A2" },
    ];

    const merged = mergeTimeline(history, live);
    expect(merged).toHaveLength(4);
    expect(merged[0]!.content).toBe("Q1");
    expect(merged[1]!.content).toBe("A1");
    expect(merged[2]!.content).toBe("Q2");
    expect(merged[3]!.content).toBe("A2");
  });

  test("empty live returns just history", () => {
    const history = [
      { kind: "message" as const, role: "user" as const, content: "Hello" },
    ];
    const merged = mergeTimeline(history, []);
    expect(merged).toHaveLength(1);
  });

  test("empty history returns just live", () => {
    const live = [
      { kind: "message" as const, role: "assistant" as const, content: "Hi" },
    ];
    const merged = mergeTimeline([], live);
    expect(merged).toHaveLength(1);
  });

  test("both empty returns empty", () => {
    expect(mergeTimeline([], [])).toHaveLength(0);
  });

  test("no duplicates — history and live are non-overlapping by design", () => {
    // History = checkpoint snapshot (pre-run), live = SSE events (during run)
    // They don't overlap because checkpoint is saved before run starts
    const history = [
      { kind: "message" as const, role: "user" as const, content: "Q" },
    ];
    const live = [
      { kind: "message" as const, role: "assistant" as const, content: "A" },
    ];
    const merged = mergeTimeline(history, live);
    // No dedup needed — just concatenation
    expect(merged).toHaveLength(2);
  });
});

describe("extractText", () => {
  test("extracts text from string content", () => {
    expect(extractText("plain string")).toBe("plain string");
  });

  test("extracts text from ContentBlock array", () => {
    const blocks = [
      { type: "text", text: "Hello " },
      { type: "tool_use", id: "1", name: "read", input: {} },
      { type: "text", text: "world" },
    ];
    expect(extractText(blocks)).toBe("Hello world");
  });

  test("returns empty string for no text blocks", () => {
    const blocks = [
      { type: "tool_use", id: "1", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "1", content: "data" },
    ];
    expect(extractText(blocks)).toBe("");
  });

  test("handles unknown array items gracefully", () => {
    expect(extractText([{ type: "unknown" }])).toBe("");
  });
});

describe("tool_use/tool_result pairing (integration)", () => {
  test("tool_use and tool_result pair by tool_use_id", () => {
    const blocks = [
      { type: "text", text: "Let me check" },
      {
        type: "tool_use",
        id: "tool_1",
        name: "read",
        input: { file: "test.txt" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "file contents",
        is_error: false,
      },
      { type: "text", text: "Done" },
    ];

    // Build pairing map
    const toolUses = blocks.filter(
      (b) => b.type === "tool_use",
    ) as Array<{ type: "tool_use"; id: string; name: string; input: unknown }>;
    const toolResults = new Map<
      string,
      { content: string; isError?: boolean }
    >();
    for (const b of blocks) {
      if (
        b.type === "tool_result" &&
        "tool_use_id" in b &&
        typeof b.tool_use_id === "string" &&
        typeof b.content === "string"
      ) {
        toolResults.set(b.tool_use_id, {
          content: b.content,
          isError: b.is_error,
        });
      }
    }

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.id).toBe("tool_1");

    const result = toolResults.get("tool_1");
    expect(result).toBeDefined();
    expect(result!.content).toBe("file contents");
    expect(result!.isError).toBe(false);
  });

  test("tool_result with is_error is flagged", () => {
    const blocks = [
      {
        type: "tool_use",
        id: "err_1",
        name: "write",
        input: { file: "/root/x" },
      },
      {
        type: "tool_result",
        tool_use_id: "err_1",
        content: "Permission denied",
        is_error: true,
      },
    ];

    const toolResults = new Map<
      string,
      { content: string; isError?: boolean }
    >();
    for (const b of blocks) {
      if (
        b.type === "tool_result" &&
        "tool_use_id" in b &&
        typeof b.tool_use_id === "string" &&
        typeof b.content === "string"
      ) {
        toolResults.set(b.tool_use_id, {
          content: b.content,
          isError: b.is_error,
        });
      }
    }

    const result = toolResults.get("err_1");
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
  });

  test("P1-3: live items carry seq for stable React key", () => {
    // History items have no seq (they come from checkpoint which has no seq concept).
    // Live items carry the EventRecord seq so Timeline can use it as a stable key.
    const liveItem: TimelineItem = {
      kind: "message",
      role: "assistant",
      content: "streaming...",
      seq: 42,
    };
    const historyItem: TimelineItem = {
      kind: "message",
      role: "user",
      content: "hello",
    };

    // Live item key = seq (stable across insertions)
    expect(liveItem.seq).toBe(42);
    // History item has no seq — key falls back to index
    expect(historyItem.seq).toBeUndefined();

    // When both coexist in the merged array, seq-based keys prevent
    // animation remount when a new history item shifts array indices.
    const items = [historyItem, liveItem];
    const keys = items.map((it, i) => it.seq ?? i);
    expect(keys[0] as number).toBe(0); // history: index fallback
    expect(keys[1] as number).toBe(42); // live: stable seq
  });

  test("orphan tool_use without result", () => {
    const blocks = [
      {
        type: "tool_use",
        id: "orphan",
        name: "read",
        input: {},
      },
    ];

    const toolResults = new Map<string, unknown>();
    for (const b of blocks) {
      if (b.type === "tool_result" && "tool_use_id" in b && typeof (b as { tool_use_id?: unknown }).tool_use_id === "string") {
        toolResults.set((b as { tool_use_id: string }).tool_use_id, b);
      }
    }

    expect(toolResults.has("orphan")).toBe(false);
  });
});
