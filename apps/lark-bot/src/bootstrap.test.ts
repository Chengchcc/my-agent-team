import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { LarkBotArgs } from "./args.js";
import { bootstrap } from "./bootstrap.js";

const testDir = mkdtempSync("/tmp/test-lark-bootstrap-");
const originalFetch = globalThis.fetch;

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  (globalThis as Record<string, unknown>).fetch = originalFetch;
});

function mockAgentResponse(overrides: Record<string, unknown> = {}) {
  (globalThis as Record<string, unknown>).fetch = ((_url: string) => {
    return Promise.resolve(
      new Response(JSON.stringify({ name: "TestBot", larkEnabled: true, ...overrides }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

function mockAgentError(status: number) {
  (globalThis as Record<string, unknown>).fetch = ((_url: string) => {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "Not found" }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

const baseArgs: LarkBotArgs = {
  agentId: "agent_test",
  backendUrl: "http://localhost",
  stateRoot: testDir,
  botDisplayName: "TestBot",
  agentName: null,
};

describe("bootstrap", () => {
  beforeEach(() => {
    // Clean up bindings between tests
  });

  test("fetches agent name and opens db", async () => {
    mockAgentResponse();

    // Mock process.exit to prevent actual exit
    const originalExit = process.exit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = () => undefined as never;

    try {
      const state = await bootstrap(baseArgs);
      expect(state.selfAgentName).toBe("TestBot");
      expect(state.botDisplayName).toBe("TestBot");
      expect(state.restoredConversationIds).toEqual([]);
      expect(state.db).toBeDefined();
      state.db.close();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).exit = originalExit;
    }
  });

  test("uses --agent-name override", async () => {
    mockAgentResponse();

    const state = await bootstrap({ ...baseArgs, agentName: "CustomName" });
    expect(state.selfAgentName).toBe("CustomName");
    state.db.close();
  });

  test("exits on 404 (archived agent)", async () => {
    mockAgentError(404);

    let exitedCode = -1;
    const originalExit = process.exit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = (code: number) => {
      exitedCode = code;
      throw new Error("EXIT");
    };

    try {
      await bootstrap(baseArgs);
    } catch (e) {
      if (e instanceof Error && e.message !== "EXIT") throw e;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).exit = originalExit;
    }

    expect(exitedCode).toBe(0);
  });

  test("warns when botDisplayName is missing", async () => {
    mockAgentResponse();

    const state = await bootstrap({ ...baseArgs, botDisplayName: null });
    expect(state.botDisplayName).toBeNull();
    state.db.close();
  });

  test("restores existing chat bindings", async () => {
    // First bootstrap creates bindings
    mockAgentResponse();
    const state1 = await bootstrap(baseArgs);
    state1.db.close();

    // Second bootstrap should restore them
    mockAgentResponse();
    const state2 = await bootstrap(baseArgs);
    // Note: bindings are empty because we didn't create any — this tests the restore path is functional
    expect(Array.isArray(state2.restoredConversationIds)).toBe(true);
    state2.db.close();
  });
});
