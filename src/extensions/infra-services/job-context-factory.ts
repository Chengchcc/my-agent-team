import type { JobContext } from '../../application/ports/job-spawner'
import type { ProviderInvoke } from '../../application/ports/provider'

export type JobContextFactory = (opts: {
  purpose: string
  runId: string
}) => JobContext

export function createJobContextFactory(
  invoke: ProviderInvoke,
  logger: {
    info: (d: string, m: string) => void
    warn: (d: string, m: string) => void
    error: (d: string, m: string) => void
  },
): JobContextFactory {
  return ({ purpose, runId }) => ({
    invoke: async (req) => {
      const resp = await invoke.call({
        kind: 'internal',
        purpose,
        parentTurnId: `${purpose}:${runId}`,
        messages: req.messages,
        maxTokens: req.maxTokens,
      })
      return { content: resp.content, usage: resp.usage }
    },
    log: (level, msg) => logger[level]('job', msg),
  })
}
