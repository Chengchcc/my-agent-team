import { describe, expect, test } from "bun:test";
import { withLarkLifecycle } from "./agent-lark.js";
import type { AgentRow } from "./domain.js";
import type { AgentService } from "./service.js";

function makeAgentRow(enabled: boolean): AgentRow {
  return {
    id: "pa-1",
    name: "PA",
    status: "active",
    workspacePath: "/tmp/pa-1",
    config: {
      role: "pa",
      lark: {
        enabled,
        app_id: "cli_1",
        profile_ref: "agent:pa-1",
        bot_display_name: "PA Bot",
        allowed_senders: ["*"],
        group_policy: "open",
        require_mention: true,
        respond_to_mention_all: false,
      },
      runtime_config: { projects: [] },
    },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  } as unknown as AgentRow;
}

describe("withLarkLifecycle", () => {
  test("updating appId + appSecret re-inits profile, stops stale bot, then restarts it", async () => {
    const calls: string[] = [];
    const baseSvc = {
      update: async () => makeAgentRow(true),
    } as unknown as AgentService;

    const svc = withLarkLifecycle({
      service: baseSvc,
      profileInit: async (profileRef, appId, appSecret) => {
        calls.push(`profileInit:${profileRef}:${appId}:${appSecret}`);
      },
      stopBot: async (id) => {
        calls.push(`stopBot:${id}`);
      },
      ensureBot: async (id) => {
        calls.push(`ensureBot:${id}`);
      },
    });

    await svc.update("pa-1", {
      lark: { appId: "cli_1", appSecret: "new-secret" },
    });

    expect(calls).toEqual([
      "profileInit:agent:pa-1:cli_1:new-secret",
      "stopBot:pa-1",
      "ensureBot:pa-1",
    ]);
  });

  test("updating non-credential lark fields does not stop the running bot", async () => {
    const calls: string[] = [];
    const baseSvc = {
      update: async () => makeAgentRow(true),
    } as unknown as AgentService;

    const svc = withLarkLifecycle({
      service: baseSvc,
      profileInit: async () => {
        calls.push("profileInit");
      },
      stopBot: async () => {
        calls.push("stopBot");
      },
      ensureBot: async (id) => {
        calls.push(`ensureBot:${id}`);
      },
    });

    await svc.update("pa-1", {
      lark: { enabled: true, botDisplayName: "Renamed Bot" },
    });

    expect(calls).toEqual(["ensureBot:pa-1"]);
  });
});
