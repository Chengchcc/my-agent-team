/**
 * Vendored from feishu-claude-code-bridge (MIT, 2025).
 * Source: https://github.com/zarazhangrui/feishu-claude-code-bridge
 * Modifications: trimmed to the union only (no AgentRun / AgentAdapter).
 */
export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; message: string };
