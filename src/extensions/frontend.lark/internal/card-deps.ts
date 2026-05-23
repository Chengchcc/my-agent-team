import type { Transport } from '../../../application/ports/transport';
import type { SessionClient } from '../../frontend.tui/session-client';
import type { CardHandlerDeps } from './card-handler';

export function createCardDeps(transport: Transport, sessionClient: SessionClient): CardHandlerDeps {
  return {
    interactiveBridge: {
      resolvePermission(sessionId: string, response: string): void {
        void transport.sendRpc({
          jsonrpc: '2.0', id: `perm-${Date.now()}`,
          method: 'permission.resolve', params: { sessionId, response },
        })
      },
      resolveAskUserQuestion(sessionId: string, data: {
        answers: Array<{ question_index: number; selected_labels: string[] }>
      }): void {
        void transport.sendRpc({
          jsonrpc: '2.0', id: `ask-${Date.now()}`,
          method: 'askuserquestion.resolve', params: { sessionId, ...data },
        })
      },
    },
    onToggleDisplay: (_sessionId: string, _cardNonce?: string) => '{}',
    onRestart: async (sessionId: string) => {
      try { await sessionClient.clearSession(sessionId) } catch { /* fallback */ }
      return '{}'
    },
    onClose: async (sessionId: string) => {
      await transport.sendRpc({
        jsonrpc: '2.0', id: `close-${Date.now()}`,
        method: 'session.close', params: { sessionId },
      })
      return '{}'
    },
  }
}
