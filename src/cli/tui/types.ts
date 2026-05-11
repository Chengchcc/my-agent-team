import type { Agent } from '../../agent';
import type { SessionStore } from '../../session/store';
import type { McpManager } from '../../mcp/manager';

/**
 * Context passed to command handlers
 */
export interface CommandHandlerContext {
  agent: Agent;
  onOutput: (message: string) => void;
  refreshMessages: () => void;
  sessionStore: SessionStore;
  args: string;
  mcpManager: McpManager | undefined;
}
