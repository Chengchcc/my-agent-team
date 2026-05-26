import { defineExtension } from '../../kernel/define-extension'
import { EchoProvider } from '../../infrastructure/llm/echo-provider'
import { ClaudeProvider } from '../../infrastructure/llm/claude-provider'
import { OpenAiProvider } from '../../infrastructure/llm/openai-provider'
import type { ProviderChat, ProviderInvoke } from '../../application/ports/provider'
import { asContractBus } from '../../application/event-bus/contract-bus'

/**
 * Create the appropriate provider based on environment configuration.
 * Priority: MY_AGENT_PROVIDER env override → Anthropic API key → OpenAI API key → Echo.
 */
function createProvider(
  env: Record<string, string | undefined>,
): ProviderChat & ProviderInvoke {
  const forced = env.MY_AGENT_PROVIDER

  if (forced === 'echo') return new EchoProvider()

  if (
    forced === 'claude' ||
    (!forced && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN))
  ) {
    /**
     * Note: MY_AGENT_PROVIDER=claude without ANTHROPIC_API_KEY will fail at
     * kernelReady (fast-fail) rather than silently degrading to Echo.
     */
    return new ClaudeProvider({
      apiKey: (env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN)!,
      model: env.MODEL,
      baseURL: env.ANTHROPIC_BASE_URL,
    })
  }

  if (forced === 'openai' || (!forced && env.OPENAI_API_KEY)) {
    return new OpenAiProvider({
      apiKey: env.OPENAI_API_KEY!,
      model: env.MODEL ?? env.OPENAI_MODEL,
      baseURL: env.OPENAI_BASE_URL,
    })
  }

  return new EchoProvider()
}

/**
 * Provider extension — provides LLM chat and invoke capabilities.
 *
 * Capabilities exposed:
 *   - provider.llm: ProviderChat & ProviderInvoke (stream + complete + call)
 *   - provider.invoke: ProviderChat & ProviderInvoke
 *
 * Hooks:
 *   - onLLMDelta: broadcasts each stream delta chunk to bus for frontends
 */
export default (env?: Record<string, string | undefined>) =>
  defineExtension({
    name: 'provider',
    enforce: 'pre',

    apply: (ctx) => {
      const contractBus = asContractBus(ctx.bus)
      const provider = createProvider(env ?? (process.env as Record<string, string | undefined>))

      return {
        provide: {
          'provider.llm': () => provider,
        },

        hooks: {
          kernelReady: {
            enforce: 'normal',
            fn: async () => {
              const info = provider as unknown as { providerId: string; model: string };
              void contractBus.emit('provider.selected', {
                providerId: info.providerId,
                model: info.model,
              });
            },
          },
          onLLMDelta: {
            enforce: 'normal',
            fn: async (chunk: unknown) => {
              // Internal event for raw provider chunks (not a contracted event)
              void ctx.bus.emit('provider.stream.chunk', chunk);
            },
          },
        },

        dispose: () => {
          // noop
        },
      }
    },
  })
