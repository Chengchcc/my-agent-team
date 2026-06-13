import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentService } from "./service.js";

export interface LarkOrchestrationDeps {
  service: AgentService;
  profileInit: (profileRef: string, appId: string, appSecret: string) => Promise<void>;
  ensureBot: (agentId: string, botDisplayName?: string | null) => Promise<void>;
  stopBot: (agentId: string) => Promise<void>;
}

/**
 * Wraps AgentService with lark-bot orchestration side effects.
 * Keeps AgentService pure — surface lifecycle effects live here in the composition root wrapper.
 */
export function withLarkOrchestration(deps: LarkOrchestrationDeps): AgentService {
  const { service, profileInit, ensureBot, stopBot } = deps;

  return {
    ...service,

    async create(input: CreateAgentInput): Promise<AgentRow> {
      const row = await service.create(input);
      if (input.lark?.enabled && row.larkProfileRef && input.lark.appId && input.lark.appSecret) {
        try {
          await profileInit(row.larkProfileRef, input.lark.appId, input.lark.appSecret);
          await ensureBot(row.id, input.lark.botDisplayName);
        } catch (err) {
          console.error(`[lark] profile/ensure failed for ${row.id}:`, err);
          // Agent created successfully — lark.status will show 'error' or 'configured'
        }
      }
      return row;
    },

    async update(id: string, input: UpdateAgentInput): Promise<AgentRow> {
      const row = await service.update(id, input);
      if (input.lark) {
        if (input.lark.enabled === true && row.larkProfileRef && input.lark.appId && input.lark.appSecret) {
          try {
            await profileInit(row.larkProfileRef, input.lark.appId, input.lark.appSecret);
            await ensureBot(id, row.larkBotDisplayName);
          } catch (err) {
            console.error(`[lark] profile/ensure failed for ${id}:`, err);
          }
        } else if (input.lark.enabled === false) {
          await stopBot(id);
        }
      }
      return row;
    },

    async archive(id: string): Promise<AgentRow> {
      const row = await service.archive(id);
      await stopBot(id);
      return row;
    },

    async hardDelete(id: string): Promise<void> {
      await stopBot(id);
      await service.hardDelete(id);
      // Profile/bindings cleanup is handled by the registry or manual intervention
    },
  };
}
