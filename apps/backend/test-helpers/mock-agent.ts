import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "../src/features/agent/domain.js";
import type { AgentService } from "../src/features/agent/service.js";

// ═══════════════════════════════════════════════════════════════
// mockAgentSvc (B - minimal data stub)
// ═══════════════════════════════════════════════════════════════

export function mockAgentSvc() {
  return {
    getById: async () => ({
      modelName: "claude",
      modelProvider: "anthropic",
      modelBaseUrl: null,
      permissionMode: "ask",
      maxSteps: null,
    }),
    exists: async () => true,
  };
}

// ═══════════════════════════════════════════════════════════════
// fakeAgentSvc (B - data stub for AgentService)
// ═══════════════════════════════════════════════════════════════

export function makeAgentRow(overrides?: Partial<AgentRow>): AgentRow {
  return {
    id: "test-agent",
    name: "test-agent",
    template: null,
    workspacePath: "/tmp/ws",
    modelProvider: "anthropic",
    modelName: "claude-sonnet-4-6",
    modelBaseUrl: null,
    permissionMode: "ask",
    maxSteps: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    larkEnabled: false,
    larkAppId: null,
    larkProfileRef: null,
    larkBotDisplayName: null,
    ...overrides,
  };
}

export function fakeAgentSvc(agents: Map<string, AgentRow> = new Map()): AgentService {
  return {
    getById: async (id: string) => {
      const agent = agents.get(id);
      if (!agent) {
        const err = new Error(`Agent not found: ${id}`);
        (err as Error & { name: string }).name = "AgentNotFoundError";
        throw err;
      }
      return agent;
    },
    exists: async (id: string) => agents.has(id),
    create: async (_input: CreateAgentInput) => {
      throw new Error("fakeAgentSvc.create not implemented - inject agents via Map instead");
    },
    list: async (_includeArchived?: boolean) => [...agents.values()],
    update: async (_id: string, _input: UpdateAgentInput) => {
      throw new Error("fakeAgentSvc.update not implemented");
    },
    archive: async (_id: string) => {
      throw new Error("fakeAgentSvc.archive not implemented");
    },
    hardDelete: async (_id: string) => {
      throw new Error("fakeAgentSvc.hardDelete not implemented");
    },
  };
}
