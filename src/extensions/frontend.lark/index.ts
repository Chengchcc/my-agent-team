import { defineExtension } from '../../kernel/define-extension'
import { RoutingTable } from './routing-table'
import type { Transport } from '../../application/ports/transport'
import { LarkBotAdapter, setLarkBotAdapterLogger } from './lark-bot-adapter'

// ── Config ─────────────────────────────────────────────────────────────

interface LarkBotConfig {
  id: string
  appId: string
  appSecretEnv: string
}

// Factory for multiple bot instances — N bots share one Agent
let botInstanceCounter = 0

function createLarkBotConfig(
  appId: string,
  appSecretEnv: string,
): LarkBotConfig {
  return {
    id: `lark-bot-${++botInstanceCounter}`,
    appId,
    appSecretEnv,
  }
}

// ── Extension definition ───────────────────────────────────────────────

export default () =>
  defineExtension({
    name: 'frontend-lark',
    enforce: 'post',
    dependsOn: ['transport-inmem', 'controlplane', 'session'],
    apply: (ctx) => {
      setLarkBotAdapterLogger(ctx.logger)

      const routingTable = new RoutingTable()
      const botAdapters = new Map<string, LarkBotAdapter>()

      return {
        provide: {
          lark: () => ({
            /** Create a bot adapter with real LarkClient. N bots share one Agent. */
            createBot(config: LarkBotConfig): LarkBotAdapter {
              const transport =
                ctx.extensions.get<Transport>('transport-inmem.transport')
              const adapter = new LarkBotAdapter(
                config.id,
                transport,
                routingTable,
                config.appId,
                config.appSecretEnv,
              )
              botAdapters.set(config.id, adapter)
              return adapter
            },

            /** Get an existing bot adapter */
            getBot(id: string): LarkBotAdapter | undefined {
              return botAdapters.get(id)
            },

            /** List all active bots */
            listBots(): string[] {
              return [...botAdapters.keys()]
            },

            /** Get the shared routing table */
            getRoutingTable(): RoutingTable {
              return routingTable
            },
          }),
        },

        hooks: {
          kernelReady: {
            enforce: 'normal',
            fn: async () => {
              ctx.logger.info('lark', 'Lark bot adapter ready')
            },
          },
          onShutdown: {
            enforce: 'pre',
            fn: async () => {
              for (const [, bot] of botAdapters) {
                await bot.stop()
              }
              routingTable.clear()
            },
          },
        },

        dispose: () => {
          botAdapters.clear()
          routingTable.clear()
        },
      }
    },
  })

export { createLarkBotConfig }
export type { LarkBotConfig }
