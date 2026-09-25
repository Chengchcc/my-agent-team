import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import type { LarkProfileProvisioner } from "./provisioner.js";
import { LarkSetupManager } from "./setup-manager.js";
import { createLarkSetupStore, type LarkSetupStore } from "./setup-store.js";

function tempStore(): LarkSetupStore {
  const dir = mkdtempSync(join(tmpdir(), "lark-setup-"));
  return createLarkSetupStore(openDb(join(dir, "backend.db")));
}

const SETUP_URL = "https://open.larkoffice.cn/setup?token=abc123";

function fakeProvisioner(): LarkProfileProvisioner {
  return {
    kind: "cli_setup",
    async start(input) {
      const timer = setTimeout(() => input.onUrl?.(SETUP_URL), 50);
      const { promise: waitForCompletion, resolve: resolveUrl } = Promise.withResolvers<string>();
      setTimeout(() => {
        clearTimeout(timer);
        resolveUrl(SETUP_URL);
      }, 200);
      return {
        setupId: `setup_${input.agentId}`,
        profileRef: input.profileRef,
        waitForCompletion,
        cancel: async () => clearTimeout(timer),
      };
    },
    async probe() {
      return "not_ready";
    },
  };
}

describe("LarkSetupManager onUrl wiring", () => {
  test("session.url is surfaced while pending, before completion", async () => {
    const manager = new LarkSetupManager(fakeProvisioner(), async () => {}, tempStore());
    try {
      const created = await manager.create({ agentId: "ag-1", brand: "feishu" });
      expect(created.url).toBeNull();

      await Bun.sleep(80);
      const pending = manager.get(created.setupId)!;
      expect(pending.url).toBe(SETUP_URL);
      expect(pending.status).toBe("pending");

      await Bun.sleep(200);
      const done = manager.get(created.setupId)!;
      expect(done.status).toBe("completed");
      expect(done.url).toBe(SETUP_URL);
    } finally {
      manager.dispose();
    }
  });
});

describe("setup sessions survive what the in-memory map could not", () => {
  test("a pending row from a previous process is expired, not 'still working'", () => {
    const store = tempStore();
    store.insert({
      setupId: "setup_old",
      agentId: "ag-1",
      profileRef: "agent:ag-1",
      botDisplayName: null,
      brand: "feishu",
      status: "pending",
      url: "https://example.test/setup",
      error: null,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 600_000,
    });
    // Its lark-cli child died with the old process: reconstructing the manager
    // is the restart.
    const manager = new LarkSetupManager(fakeProvisioner(), async () => {}, store);
    try {
      const recovered = manager.get("setup_old");
      expect(recovered?.status).toBe("expired");
      // The tombstone is readable, which is what makes `setup_expired` sayable.
      expect(recovered?.url).toBe("https://example.test/setup");
    } finally {
      manager.dispose();
    }
  });

  test("the newest session wins, not whichever the map yielded first", () => {
    const store = tempStore();
    const base = {
      agentId: "ag-2",
      profileRef: "agent:ag-2",
      botDisplayName: null,
      brand: "feishu" as const,
      url: null,
      error: null,
      expiresAt: Date.now() + 600_000,
    };
    store.insert({
      ...base,
      setupId: "setup_a",
      status: "cancelled",
      createdAt: 10,
      updatedAt: 10,
    });
    store.insert({ ...base, setupId: "setup_b", status: "pending", createdAt: 20, updatedAt: 20 });
    const manager = new LarkSetupManager(fakeProvisioner(), async () => {}, store);
    try {
      // Boot marked the pending one expired, but it is still the newest.
      expect(manager.getByAgentId("ag-2")?.setupId).toBe("setup_b");
    } finally {
      manager.dispose();
    }
  });

  test("an expired session is what the surface view reports", async () => {
    const store = tempStore();
    store.insert({
      setupId: "setup_exp",
      agentId: "ag-3",
      profileRef: "agent:ag-3",
      botDisplayName: null,
      brand: "feishu",
      status: "expired",
      url: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    });
    const session = store.latestForAgent("ag-3");
    expect(session?.status).toBe("expired");
  });
});
