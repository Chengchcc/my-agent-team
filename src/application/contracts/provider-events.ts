// ── provider.selected ─────────────────────────────────────────────────────────

export interface ProviderSelectedV1 {
  providerId: string;
  model: string;
  mode?: 'stream' | 'call' | 'both';
}

// ── llm.delta ─────────────────────────────────────────────────────────────────

export interface LlmDeltaV1 {
  delta: string;
}
