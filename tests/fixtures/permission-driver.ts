export interface PermissionBridge {
  handleCardAction?: (action: string, data: Record<string, unknown>) => Promise<void>;
  resolvePermission?: (sessionId: string, decision: 'allow' | 'deny') => Promise<void>;
}

/**
 * Programmatic card action simulator for permission tests.
 *
 * Drives permission flows without requiring a real Lark Card Action
 * callback — useful for unit-testing the card-handler and interactive-bridge.
 */
export class PermissionDriver {
  static async simulateAllow(
    bridge: PermissionBridge,
    sessionId: string,
    toolName: string,
  ): Promise<void> {
    if (bridge.handleCardAction) {
      await bridge.handleCardAction('allow', { session_id: sessionId, tool_name: toolName });
    }
  }

  static async simulateDeny(
    bridge: PermissionBridge,
    sessionId: string,
    toolName: string,
  ): Promise<void> {
    if (bridge.handleCardAction) {
      await bridge.handleCardAction('deny', { session_id: sessionId, tool_name: toolName });
    }
  }
}
