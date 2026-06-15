// ─── M16.3 Price table (code constants, USD per 1M tokens) ───

export interface Usage {
  input: number;
  output: number;
  cacheCreate?: number;
  cacheRead?: number;
}

interface PriceTier {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const PRICE_TABLE: Record<string, PriceTier> = {
  "claude-opus-4":   { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  "claude-opus-4-5": { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  "claude-sonnet-4": { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3,  output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1,  output: 5,   cacheRead: 0.1,  cacheWrite: 1.25 },
  "claude-opus-4-7": { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
};

/** Match longest prefix match against known model ids. */
function matchPrefix(model: string): PriceTier | undefined {
  // Exact match first
  if (PRICE_TABLE[model]) return PRICE_TABLE[model];
  // Prefix match: sort keys by length desc so longer prefixes match first
  const keys = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (model.startsWith(k)) return PRICE_TABLE[k];
  }
  return undefined;
}

/**
 * Estimate cost for a single LLM call. Returns null when the model is unknown
 * (including "unknown") — callers must NOT forge 0 in that case.
 */
export function estimateCost(model: string, usage: Usage): number | null {
  const p = matchPrefix(model);
  if (!p) return null;
  return (
    (usage.input * p.input +
      usage.output * p.output +
      (usage.cacheRead ?? 0) * (p.cacheRead ?? 0) +
      (usage.cacheCreate ?? 0) * (p.cacheWrite ?? 0)) /
    1_000_000
  );
}
