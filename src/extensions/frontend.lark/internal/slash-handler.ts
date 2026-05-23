import type { Anchor } from '../anchor';
import type { RoutingTable } from '../routing-table';
import type { SlashRegistry, SlashContext } from '../../../application/slash';
import type { SessionClient } from '../../frontend.tui/session-client';

let ctxWarn: (tag: string, msg: string) => void = () => {};

export function setSlashHandlerLogger(logger: typeof ctxWarn): void {
  ctxWarn = logger;
}

export async function tryHandleSlashCommand(
  deps: {
    slashRegistry: SlashRegistry;
    routingTable: RoutingTable;
    sessionClient: SessionClient;
    appId: string;
  },
  sendToLark: (chatId: string, msg: string) => Promise<string>,
  anchor: Anchor,
  text: string,
  chatId: string,
): Promise<{ sessionId: string; accepted: boolean } | null> {
  const resolved = deps.slashRegistry.resolve(text)
  if (!resolved) return null
  let sessionId = deps.routingTable.resolve(deps.appId, anchor)
  const slashCtx: SlashContext = {
    frontend: 'lark-bot',
    sessionId: sessionId ?? '',
    userInputRaw: text,
    kernel: {
      rpc: async (method, params) => {
        return deps.sessionClient.sendRpc(method, { ...params, sessionId: sessionId ?? 'main' })
      },
    },
    reply: { text: async (msg) => { await sendToLark(chatId, msg) } },
  }
  const result = await resolved.command.resolve(text, slashCtx)
  switch (result.kind) {
    case 'handled':
      if (result.message) await sendToLark(chatId, result.message)
      break
    case 'submit-prompt':
      try { await deps.sessionClient.sendInput(sessionId ?? 'main', result.text) } catch { /* fallback */ }
      break
    case 'replace-input': break
    case 'render-widget':
      ctxWarn('lark', 'render-widget result kind not supported')
      break
    default: break
  }
  return { sessionId: sessionId ?? 'main', accepted: true }
}
