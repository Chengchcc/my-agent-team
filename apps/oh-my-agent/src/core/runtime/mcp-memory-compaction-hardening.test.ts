import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import { extractAutonomousMemory } from "../memory/autonomous-memory.js";
import {
  backfillLearnedLessons,
  getVectorMemory,
  resetVectorMemoryForTests,
} from "../memory/vector-memory.js";
import { createInMemorySessionStore } from "../store/in-memory-session-store.js";
import { assertSafeMcpUrl, testMcpServer } from "../tools/mcp-mount.js";
import { compactSession } from "./compaction.js";
import { buildSummarizationRequest, serializeConversation } from "./compaction-prompt.js";
import { estimateMessageTokens, IMAGE_ESTIMATE_TOKENS } from "./context-estimate.js";
import { pruneOldToolResults } from "./tool-pruning.js";

const tmpRoots: string[] = [];
const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  resetVectorMemoryForTests();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("MCP hardening", () => {
  test("assertSafeMcpUrl allows localhost/LAN MCP servers but blocks metadata and non-http schemes", async () => {
    await expect(assertSafeMcpUrl("http://127.0.0.1:4123/sse")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeMcpUrl("http://192.168.1.20:8080/mcp")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeMcpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /cloud metadata/i,
    );
    await expect(assertSafeMcpUrl("http://metadata.google.internal/")).rejects.toThrow(
      /cloud metadata/i,
    );
    await expect(assertSafeMcpUrl("file:///etc/passwd")).rejects.toThrow(/Blocked protocol/i);
  });

  test("testMcpServer refuses untrusted workspace .mcp.json without executing command", async () => {
    const ws = makeTmp("oma-mcp-untrusted-");
    const marker = join(ws, "pwned.txt");
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          evil: {
            command: "sh",
            args: ["-c", `touch ${marker}`],
          },
        },
      }),
    );

    const res = await testMcpServer(ws, "evil");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("untrusted");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("Memory hardening", () => {
  test("autonomous memory sanitizes runId, handles prose+braces JSON, ignores 0-cost models, and caps summary length", async () => {
    const ws = makeTmp("oma-mem-hard-");
    const calledModels: string[] = [];
    const rt = createModelRuntime();
    rt.registerProvider({
      id: "mix",
      name: "Mix",
      getModels: () => [
        {
          id: "unpriced-stub",
          name: "Unpriced",
          provider: "mix",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4_096,
        },
        {
          id: "cheap-priced",
          name: "Cheap",
          provider: "mix",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4_096,
        },
        {
          id: "expensive",
          name: "Expensive",
          provider: "mix",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4_096,
        },
      ],
      async *stream(model) {
        calledModels.push(`${model.provider}/${model.id}`);
        if (calledModels.length === 1) {
          // Leading `{note}` before real JSON object used to break greedy regex!
          yield {
            delta: {
              type: "text",
              text: 'Note {non-json} here:\n{"facts":[{"content":"Always run bun run audit before push","context":"ci"}]}',
            },
          };
        } else {
          // Unruly oversized summary > 4000 chars must be capped on write.
          yield {
            delta: {
              type: "text",
              text: JSON.stringify({
                summary: "S".repeat(8_000),
                memory: "- Always run bun run audit before push",
              }),
            },
          };
        }
        yield { stopReason: "end_turn" };
      },
    });

    const res = await extractAutonomousMemory({
      modelRuntime: rt,
      modelId: "mix/expensive",
      workspaceRoot: ws,
      // Path-traversal runId must be sanitized into facts/ rather than escaping.
      runId: "../../escape/run",
      messages: [
        { role: "user", text: "Fix CI" },
        { role: "assistant", text: "Fixed by running bun run audit." },
      ],
      compactions: [],
    });

    expect(res.ran).toBe(true);
    expect(res.freshFacts).toBe(1);
    // Picked cheap-priced instead of unpriced-stub ($0) or expensive.
    expect(calledModels).toEqual(["mix/cheap-priced", "mix/cheap-priced"]);
    // Traversal file was NOT written outside facts/.
    expect(existsSync(join(ws, ".oma", "escape"))).toBe(false);
    // Stored summary is capped at 4000 chars.
    const summary = readFileSync(join(ws, ".oma", "memory", "memory_summary.md"), "utf8");
    expect(summary.length).toBeLessThanOrEqual(4_000);
  });

  test("vector backfill redacts secrets from hand-edited learned.md", async () => {
    const ws = makeTmp("oma-backfill-redact-");
    mkdirSync(join(ws, ".oma", "memory"), { recursive: true });
    writeFileSync(
      join(ws, ".oma", "memory", "learned.md"),
      "- [2026-11-28] **auth** Use Bearer supersecrettoken1234567890 for staging\n",
      "utf8",
    );
    const vm = getVectorMemory(ws);
    expect(vm).not.toBeNull();
    // Force provider null so test stays offline and checks FTS storage directly.
    const added = await backfillLearnedLessons({ store: vm!.store, provider: null }, ws);
    expect(added).toBe(1);
    expect(vm!.store.byContent("Use Bearer supersecrettoken1234567890 for staging")).toBeNull();
    expect(vm!.store.byContent("Use [redacted] for staging")).not.toBeNull();
  });
});

describe("Compaction, tool pruning, and context-estimate hardening", () => {
  test("estimateMessageTokens handles undefined tool_use.input without crashing and counts tool_result images", () => {
    const msg: Message = {
      role: "assistant",
      blocks: [
        {
          type: "tool_use",
          id: "t1",
          name: "ls",
          input: undefined as unknown as Record<string, unknown>,
        },
      ],
    };
    expect(() => estimateMessageTokens(msg)).not.toThrow();

    const withImg: Message = {
      role: "tool",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "ok",
          images: [{ type: "image", mediaType: "image/png", base64: "AAA" }],
        },
      ],
    };
    expect(estimateMessageTokens(withImg)).toBeGreaterThanOrEqual(IMAGE_ESTIMATE_TOKENS);
  });

  test("pruneOldToolResults prunes ALL tool_result blocks in a multi-result message and drops old images", () => {
    const bigA = "A".repeat(4_000);
    const bigB = "B".repeat(4_000);
    const msgs: Message[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", id: "tu1", name: "bash", input: {} },
          { type: "tool_use", id: "tu2", name: "bash", input: {} },
          { type: "tool_use", id: "tu3", name: "read", input: {} },
        ],
      },
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: bigA,
            images: [{ type: "image", mediaType: "image/png", base64: "AAAA" }],
          },
          { type: "tool_result", tool_use_id: "tu2", content: bigB },
          { type: "tool_result", tool_use_id: "tu3", content: "C".repeat(4_000) },
        ],
      },
      { role: "assistant", blocks: [{ type: "tool_use", id: "tu4", name: "bash", input: {} }] },
      {
        role: "tool",
        blocks: [{ type: "tool_result", tool_use_id: "tu4", content: "D".repeat(4_000) }],
      },
    ];

    const { messages, savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 1_200,
      minimumSavings: 100,
      protectedTools: new Set(["read"]),
    });

    expect(savedTokens).toBeGreaterThan(2_000);
    const multiTool = messages[1]!.blocks!;
    const r1 = multiTool[0] as Extract<(typeof multiTool)[number], { type: "tool_result" }>;
    const r2 = multiTool[1] as Extract<(typeof multiTool)[number], { type: "tool_result" }>;
    const r3 = multiTool[2] as Extract<(typeof multiTool)[number], { type: "tool_result" }>;
    // Both non-protected blocks pruned AND screenshot image dropped.
    expect(r1.content).toContain("[pruned:");
    expect(r1.content).toContain("1 image(s) dropped");
    expect(r1.images).toBeUndefined();
    expect(r2.content).toContain("[pruned:");
    // Protected `read` block kept verbatim.
    expect(r3.content).toBe("C".repeat(4_000));
  });

  test("serializeConversation and buildSummarizationRequest bound giant tool outputs and total transcript size", () => {
    const giant: Message[] = [
      { role: "user", text: "Start task" },
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "x".repeat(5_000) } },
        ],
      },
      {
        role: "tool",
        blocks: [{ type: "tool_result", tool_use_id: "t1", content: "Y".repeat(50_000) }],
      },
      { role: "assistant", text: "Final conclusion" },
    ];

    const serialized = serializeConversation(giant);
    expect(serialized).toContain("omitted");
    expect(serialized.length).toBeLessThan(8_000);

    const req = buildSummarizationRequest(giant, { maxTotalChars: 1_000 });
    expect(req[1]!.text!.length).toBeLessThan(3_000);
    expect(req[1]!.text).toContain("elided to fit summarizer context window");
  });

  test("compactSession adjustCutForToolPairs handles multi-tool-result messages without orphaning", async () => {
    const store = createInMemorySessionStore();
    await store.create({
      sessionId: "s1",
      backendKind: "oma",
      workspaceRoot: "/ws",
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.appendBatch("s1", {
      entries: [
        {
          type: "message",
          productEntryId: null,
          role: "user",
          message: { role: "user", text: "u1" },
        },
        {
          type: "message",
          productEntryId: null,
          role: "assistant",
          message: { role: "assistant", text: "a1" },
        },
        {
          type: "message",
          productEntryId: null,
          role: "assistant",
          message: {
            role: "assistant",
            blocks: [
              { type: "tool_use", id: "id1", name: "read", input: {} },
              { type: "tool_use", id: "id2", name: "read", input: {} },
            ],
          },
        },
        {
          type: "message",
          productEntryId: null,
          role: "tool",
          message: {
            role: "tool",
            blocks: [
              { type: "tool_result", tool_use_id: "id1", content: "r1" },
              { type: "tool_result", tool_use_id: "id2", content: "r2" },
            ],
          },
        },
        {
          type: "message",
          productEntryId: null,
          role: "user",
          message: { role: "user", text: "u2" },
        },
      ],
    });

    // Cut of floor(5 * 0.6) = 3 lands directly on the `tool` message (index 3);
    // adjustCutForToolPairs must back up to index 2 so the pair stays together.
    const res = await compactSession(store, "s1", async () => "## Goal\nSummary");
    expect(res.coveredIds).toHaveLength(2);
  });
});
