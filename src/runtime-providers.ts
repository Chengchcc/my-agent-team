import type { Provider } from './types';
import type { RuntimeConfig } from './runtime';
import type { EvolutionModule } from './evolution';
import { ClaudeProvider, OpenAIProvider } from './providers';
import { DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_EVOLUTION_MAX_TURNS, DEFAULT_EVOLUTION_TOKEN_LIMIT, DEFAULT_EVOLUTION_TIMEOUT_MS, DEFAULT_AUTO_ACCEPT_HOURS, DEFAULT_LOW_SCORE_THRESHOLD } from './config/constants';
import { useTuiStore } from './cli/tui/state/store';
import { initEvolution } from './evolution';

/**
 * Create provider from environment variables (headless mode fallback).
 */
export function createProviderFromEnv(config: RuntimeConfig): Provider {
  const {
    provider: providerName,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = config;

  const hasClaudeKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasOpenaiKey = !!process.env.OPENAI_API_KEY;

  // Resolve provider: explicit > auto-detect from available keys
  const resolved = providerName ?? (hasClaudeKey ? 'claude' : hasOpenaiKey ? 'openai' : null);

  if (resolved === 'claude' && hasClaudeKey) {
    return buildClaudeFromEnv(model, maxTokens);
  }
  if (resolved === 'openai' && hasOpenaiKey) {
    return buildOpenaiFromEnv(model, maxTokens);
  }

  if (providerName) {
    throw new Error(`Provider '${providerName}' not available or no API key found.`);
  }
  throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}

export function buildClaudeFromEnv(model: string | undefined, maxTokens: number): ClaudeProvider {
  return new ClaudeProvider({
    apiKey: (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)!,
    model: model || process.env.MODEL || DEFAULT_MODEL,
    maxTokens,
    temperature: DEFAULT_TEMPERATURE,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
  });
}

export function buildOpenaiFromEnv(model: string | undefined, maxTokens: number): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: model || process.env.MODEL || 'gpt-4o',
    maxTokens,
    temperature: DEFAULT_TEMPERATURE,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
}

export function setupEvolution(settings: RuntimeConfig['settings']): EvolutionModule | null {
  const review = settings?.trace?.review;
  if (!review || review.enabled === false) return null;
  const model = review.model ?? 'claude-3-haiku-20240307';
  return initEvolution({
    enabled: true,
    model,
    maxTurns: review.maxTurns ?? DEFAULT_EVOLUTION_MAX_TURNS,
    tokenLimit: review.tokenLimit ?? DEFAULT_EVOLUTION_TOKEN_LIMIT,
    timeoutMs: review.timeoutMs ?? DEFAULT_EVOLUTION_TIMEOUT_MS,
    outputDir: review.outputDir ?? '~/.my-agent/skills/auto',
    autoAcceptHours: review.autoAcceptHours ?? DEFAULT_AUTO_ACCEPT_HOURS,
    lowScoreWarningThreshold: review.lowScoreWarningThreshold ?? DEFAULT_LOW_SCORE_THRESHOLD,
  }, createEvolutionProvider(model), (skillName, description, outputDir) => {
    useTuiStore.getState().addReviewNotification(skillName, description, outputDir);
  });
}

/**
 * Create a lightweight provider for the evolution review agent.
 * Uses the same API credentials as the main agent but with the
 * review-specific model (e.g. claude-3-haiku).
 */
export function createEvolutionProvider(model: string): Provider {
  const hasClaudeKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (hasClaudeKey) {
    return new ClaudeProvider({
      apiKey: (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)!,
      model,
      maxTokens: DEFAULT_EVOLUTION_TOKEN_LIMIT,
      temperature: 0.3,
    });
  }
  return new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model,
    maxTokens: DEFAULT_EVOLUTION_TOKEN_LIMIT,
    temperature: 0.3,
  });
}
