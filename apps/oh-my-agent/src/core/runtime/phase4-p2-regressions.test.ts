import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PASSWORD_RESET_MARKER } from "@chengchenccc/config/node";
import type { AIMessageChunk, Message, Tool } from "@chengchenccc/message";
import { AskPanel } from "../../modes/tui/ask-panel.js";
import { omaVersion } from "../../version.js";
import { createInMemorySessionStore } from "../index.js";
import { closeAllVectorMemories, getVectorMemory } from "../memory/vector-memory.js";
import { createRetainTool } from "../memory/vector-tools.js";
import {
  appendParkedTurnMarker,
  appendSessionMessages,
  deleteSession,
  findInterruptedSession,
  forkSessionAtEvent,
  loadLastParkedTurn,
  loadSessionBranchNodes,
  loadSessionMessages,
} from "../session/session-file.js";
import type { OmaLoopEvent } from "./agent-event.js";
import { createOmaSession } from "./agent-loop.js";
import { safeParseJson } from "./agent-loop-utils.js";
import { toPluginTool } from "./run-runtime.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Phase 4 P2 regressions", () => {
  test("package hygiene: no postinstall, optional puppeteer-core, shared PASSWORD_RESET_MARKER, version helper", () => {
    const pkgPath = resolve(import.meta.dirname, "../../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.dependencies?.["puppeteer-core"]).toBeUndefined();
    expect(pkg.optionalDependencies?.["puppeteer-core"]).toBeDefined();
    expect(omaVersion()).toBe(pkg.version);
    expect(PASSWORD_RESET_MARKER).toBe("password-reset");
  });

  test("P2-1 & P2-4: toPluginTool forwards describeResult; safeParseJson rejects non-objects", () => {
    const nativeTool: Tool = {
      name: "demo_grep",
      description: "demo",
      inputSchema: { type: "object", properties: {} },
      describeResult: (_input, result) =>
        `matched ${String((result as { content?: string }).content)}`,
      execute: () => ({ content: "3 hits" }),
    };
    const adapted = toPluginTool(nativeTool);
    expect(adapted.describeResult).toBeDefined();
    expect(adapted.describeResult?.({}, { content: "3 hits" })).toBe("matched 3 hits");

    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseJson("null")).toEqual({});
    expect(safeParseJson("[1,2,3]")).toEqual({});
    expect(safeParseJson("42")).toEqual({});
    expect(safeParseJson("{bad")).toEqual({});
  });

  test("P2-2 & P2-4: onPersistMessages skips on appendBatch failure; afterTool patch reaches tool_execution_end", async () => {
    const persisted: Message[] = [];
    const failingStore = createInMemorySessionStore();
    const origAppend = failingStore.appendBatch.bind(failingStore);
    failingStore.appendBatch = async () => {
      throw new Error("disk full");
    };
    const failingSession = createOmaSession({
      sessionId: "s-fail",
      store: failingStore,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      modelStream: async function* () {
        yield { delta: { type: "text", text: "ok" } };
      },
      summarize: async () => "sum",
      onPersistMessages: (msgs) => persisted.push(...msgs),
    });
    const failOutcome = await failingSession.startLoop({
      run: {
        runId: "r-fail",
        model: { providerId: "fake", modelId: "m" },
        systemPrompt: "",
      },
      workspace: { root: "/tmp" },
      input: { message: { role: "user", text: "hi" } },
    });
    expect(failOutcome.status).toBe("failed");
    expect(failOutcome.error).toContain("disk full");
    expect(persisted).toHaveLength(0);
    // Restore reference sanity (unused variable guard)
    expect(typeof origAppend).toBe("function");

    const store = createInMemorySessionStore();
    await store.create({
      sessionId: "s-patch",
      backendKind: "oma",
      workspaceRoot: tmpdir(),
      leafEntryId: null,
      createdAt: Date.now(),
    });
    let turn = 0;
    const events: OmaLoopEvent[] = [];
    const session = createOmaSession({
      sessionId: "s-patch",
      store,
      plugins: [
        {
          name: "patcher",
          tools: [
            {
              name: "ping",
              description: "ping",
              inputSchema: { type: "object", properties: {} },
              execute: async () => ({ content: "raw" }),
            },
          ],
          hooks: {
            afterTool: (_name, _res) => ({
              content: { content: "patched" },
              isError: true,
            }),
          },
        },
      ],
      maxSteps: 4,
      maxForceContinues: 0,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        turn++;
        if (turn === 1) {
          yield {
            delta: { type: "tool_use", id: "c1", name: "ping" },
          };
          yield { delta: { type: "input_json_delta", id: "c1", partial_json: "{}" } };
          return;
        }
        yield { delta: { type: "text", text: "done" } };
      },
      summarize: async () => "sum",
    });
    session.onEvent((e) => {
      events.push(e);
    });
    await session.startLoop({
      run: { runId: "r-patch", model: { providerId: "fake", modelId: "m" }, systemPrompt: "" },
      workspace: { root: "/tmp" },
      input: { message: { role: "user", text: "run ping" } },
    });
    const endEvt = events.find((e) => e.type === "tool_execution_end");
    expect(endEvt).toBeDefined();
    if (endEvt && endEvt.type === "tool_execution_end") {
      expect(endEvt.isError).toBe(true);
      expect(endEvt.result).toEqual({ content: "patched" });
    }
  });

  test("P2-3: session-file guards bad filenames, supersedes stale parked_turn, includes paired tool_result on fork", () => {
    const dir = tempDir("oma-p4-session-");
    try {
      // Invalid filename with dot should not crash findInterruptedSession.
      writeFileSync(join(dir, "corrupt.bak.jsonl"), '{"type":"parked_turn"}\n');

      appendSessionMessages("sess-1", "/tmp", [{ role: "user", text: "hello" }], dir);
      appendParkedTurnMarker(
        "sess-1",
        { role: "assistant", blocks: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
        dir,
      );
      expect(findInterruptedSession(dir)).toBe("sess-1");

      // A later user turn supersedes the stale parked_turn marker.
      appendSessionMessages("sess-1", "/tmp", [{ role: "user", text: "new turn" }], dir);
      expect(loadLastParkedTurn("sess-1", dir)?.interrupted).toBe(false);
      expect(findInterruptedSession(dir)).toBeNull();

      // Forking at assistant(tool_use) must include its immediately paired tool_result.
      appendSessionMessages(
        "sess-fork",
        "/tmp",
        [
          { role: "user", text: "run" },
          { role: "assistant", blocks: [{ type: "tool_use", id: "u1", name: "read", input: {} }] },
          { role: "tool", blocks: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] },
          { role: "assistant", text: "finished" },
        ],
        dir,
      );
      const nodes = loadSessionBranchNodes("sess-fork", dir);
      const toolUseNode = nodes[1]!;
      const forkedId = forkSessionAtEvent("sess-fork", toolUseNode.id, dir);
      expect(forkedId).not.toBeNull();
      const forkedMsgs = loadSessionMessages(forkedId!, dir);
      expect(forkedMsgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

      expect(deleteSession("sess-1", dir)).toBe(true);
      expect(deleteSession("sess-1", dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("P2-5 & P2-7: vector retain detects duplicates & closes cleanly; AskPanel multi-select preserves Other text", async () => {
    const dir = tempDir("oma-p4-vec-");
    const prevOff = process.env.OMA_EMBEDDINGS;
    process.env.OMA_EMBEDDINGS = "off";
    try {
      const mem = getVectorMemory(dir);
      expect(mem).not.toBeNull();
      const retain = createRetainTool(mem!);
      const first = await retain.execute({ content: "unique phase 4 lesson" });
      expect(String(first.content)).toStartWith("stored ");
      const second = await retain.execute({ content: "unique phase 4 lesson" });
      expect(String(second.content)).toContain("duplicate of an existing memory");
      closeAllVectorMemories();
    } finally {
      if (prevOff === undefined) delete process.env.OMA_EMBEDDINGS;
      else process.env.OMA_EMBEDDINGS = prevOff;
      rmSync(dir, { recursive: true, force: true });
    }

    // AskPanel multi-select: typing Other then toggling an option keeps both!
    let settled: unknown = null;
    const panel = new AskPanel(
      {
        questions: [
          {
            id: "q1",
            question: "Pick features",
            multi: true,
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ],
          },
        ],
      },
      {
        onSettle: (r) => {
          settled = r;
        },
        requestRender: () => {},
      },
    );
    // Move to Other row (index 2), open freeText, type "custom", press Enter to commit.
    panel.handleInput("\u001b[B"); // -> Beta (1)
    panel.handleInput("\u001b[B"); // -> Other (2)
    panel.handleInput("\r"); // open Other field
    panel.handleInput("custom");
    panel.handleInput("\r"); // commit Other text
    // Move back up to Alpha (index 0) and toggle it with space.
    panel.handleInput("\u001b[A"); // -> Beta (1)
    panel.handleInput("\u001b[A"); // -> Alpha (0)
    panel.handleInput(" "); // toggle Alpha ON
    // Tab to Submit and press Enter.
    panel.handleInput("\t");
    panel.handleInput("\r");
    expect(settled).toEqual({
      answers: [{ id: "q1", selectedValues: ["a"], freeText: "custom" }],
    });
  });
});
