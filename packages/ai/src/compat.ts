import type { AnthropicCompat, Model, OpenAICompat, ThinkingLevel } from "./types.js";

// ─── Anthropic compat resolver ───

const DEFAULT_ANTHROPIC = {
  supportsCacheControlOnTools: true,
  forceAdaptiveThinking: false,
  allowEmptySignature: false,
} as const;

export interface ResolvedAnthropicCompat {
  supportsCacheControlOnTools: boolean;
  forceAdaptiveThinking: boolean;
  allowEmptySignature: boolean;
}

export function resolveAnthropicCompat(model: Model): ResolvedAnthropicCompat {
  const c = model.compat as AnthropicCompat | undefined;
  if (!c || model.api !== "anthropic-messages") return DEFAULT_ANTHROPIC;
  return {
    supportsCacheControlOnTools:
      c.supportsCacheControlOnTools ?? DEFAULT_ANTHROPIC.supportsCacheControlOnTools,
    forceAdaptiveThinking: c.forceAdaptiveThinking ?? DEFAULT_ANTHROPIC.forceAdaptiveThinking,
    allowEmptySignature: c.allowEmptySignature ?? DEFAULT_ANTHROPIC.allowEmptySignature,
  };
}

// ─── OpenAI compat resolver ───

const DEFAULT_OPENAI = {
  thinkingFormat: "none" as const,
  maxTokensField: "max_tokens" as const,
  supportsReasoningEffort: false,
  supportsDeveloperRole: false,
};

export interface ResolvedOpenAICompat {
  thinkingFormat: "none" | "deepseek" | "qwen" | "zai" | "openrouter";
  maxTokensField: "max_tokens" | "max_completion_tokens";
  supportsReasoningEffort: boolean;
  supportsDeveloperRole: boolean;
}

export function resolveOpenAICompat(model: Model): ResolvedOpenAICompat {
  const c = model.compat as OpenAICompat | undefined;
  if (!c) return DEFAULT_OPENAI;
  return {
    thinkingFormat: c.thinkingFormat ?? DEFAULT_OPENAI.thinkingFormat,
    maxTokensField: c.maxTokensField ?? DEFAULT_OPENAI.maxTokensField,
    supportsReasoningEffort: c.supportsReasoningEffort ?? DEFAULT_OPENAI.supportsReasoningEffort,
    supportsDeveloperRole: c.supportsDeveloperRole ?? DEFAULT_OPENAI.supportsDeveloperRole,
  };
}

// ─── Thinking level clamp + wire effort mapping ───

const THINKING_LADDER: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

/** Clamp a thinking level to the nearest supported rung on a model.
 *  Walks down the ladder first (e.g. xhigh → high when xhigh is unsupported),
 *  falling back to the lowest supported rung when nothing below is supported. */
export function clampThinkingLevel(model: Model, level: ThinkingLevel): ThinkingLevel {
  const map = model.thinkingLevelMap;
  if (!map) return level;
  if (map[level] === null) {
    const idx = THINKING_LADDER.indexOf(level);
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = THINKING_LADDER[i]!;
      if (map[candidate] !== null && map[candidate] !== undefined) return candidate;
    }
    for (const key of THINKING_LADDER) {
      if (map[key] !== null && map[key] !== undefined) return key;
    }
  }
  return level;
}

/** Resolve a requested effort level to the provider wire string using the
 *  model's `thinkingLevelMap` (clamping unsupported rungs downward) or the
 *  protocol's `fallbackClamp` table. Returns undefined when effort is unset or
 *  clamps to "off". */
export function resolveEffort(
  model: Model,
  effort: Exclude<ThinkingLevel, "off"> | undefined,
  fallbackClamp?: Readonly<Record<string, string>>,
): string | undefined {
  if (!effort) return undefined;
  const map = model.thinkingLevelMap;
  if (map) {
    const clamped = clampThinkingLevel(model, effort);
    if (clamped === "off") return undefined;
    const mapped = map[clamped];
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
    return fallbackClamp?.[clamped] ?? clamped;
  }
  return fallbackClamp?.[effort] ?? effort;
}

// ─── Shared UTF-16 surrogate sanitization ───

/** Replace unpaired UTF-16 surrogates with U+FFFD so partially-decoded file
 *  reads or command output never trigger 400 JSON/UTF-8 rejections on any
 *  provider. Valid surrogate pairs (emoji, CJK ext B) are preserved. */
export function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}
