import { defineExtension } from '../../kernel/define-extension'
import { RoutingTable } from './routing-table'
import { LarkBotAdapter, setLarkBotAdapterLogger } from './lark-bot-adapter'
import { randomUUID } from 'node:crypto'

const UUID_SLICE_LEN = 8

// ── Config ─────────────────────────────────────────────────────────────

interface LarkBotConfig {
  id: string
  appId: string
  appSecretEnv: string
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
          'frontend-lark.lark': () => ({
            /** Create a bot adapter with real LarkClient. N bots share one Agent. */
            createBot(config: LarkBotConfig): LarkBotAdapter {
              const transport =
                ctx.extensions.get('transport-inmem.transport')
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

              // Auto-start bots from config
              const larkCfg = ctx.config.get<{ bots?: Array<{ appId: string; appSecretEnv: string; autoStart?: boolean }> } | undefined>(
                'lark',
                (raw) => raw as { bots?: Array<{ appId: string; appSecretEnv: string; autoStart?: boolean }> } | undefined,
              )
              const bots = larkCfg?.bots ?? []
              const autoBots = bots.filter((b) => b.autoStart !== false)

              for (const botCfg of autoBots) {
                const botId = `lark-bot-${randomUUID().slice(0, UUID_SLICE_LEN)}`
                try {
                  const transport = ctx.extensions.get('transport-inmem.transport')
                  const adapter = new LarkBotAdapter(
                    botId,
                    transport,
                    routingTable,
                    botCfg.appId,
                    botCfg.appSecretEnv,
                  )
                  botAdapters.set(botId, adapter)
                  await adapter.start()
                  ctx.logger.info('lark', `Bot '${botId}' auto-started`)
                } catch (err) {
                  ctx.logger.warn('lark', `Failed to auto-start bot '${botId}': ${String(err)}`)
                }
              }
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

/** Create a LarkBotConfig with a UUID-based bot ID (for external callers). */
export function createLarkBotConfig(
  appId: string,
  appSecretEnv: string,
): LarkBotConfig {
  return {
    id: `lark-bot-${randomUUID().slice(0, UUID_SLICE_LEN)}`,
    appId,
    appSecretEnv,
  }
}

export type { LarkBotConfig }
