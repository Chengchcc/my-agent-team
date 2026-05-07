// --- Token defaults ---
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TOKEN_LIMIT = 180_000;
export const DEFAULT_THINKING_BUDGET = 8000;
export const DEFAULT_COMPACTION_BUFFER = 2048;
export const DEFAULT_MAX_SUMMARY_TOKENS = 1024;

// --- Model defaults ---
export const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
export const DEFAULT_SUMMARY_MODEL = 'claude-3-5-haiku-20241022';

// --- LLM defaults ---
export const DEFAULT_TEMPERATURE = 0.7;

// --- Config paths ---
export const CONFIG_DIR_NAME = '.my-agent';
export const CONFIG_FILE_NAME = 'settings.yml';

// --- MCP defaults ---
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_RECONNECT_ATTEMPTS = 3;
export const DEFAULT_MCP_RECONNECT_DELAY_MS = 1_000;

// --- Evolution defaults ---
export const DEFAULT_EVOLUTION_MAX_TURNS = 6;
export const DEFAULT_EVOLUTION_TOKEN_LIMIT = 30_000;
export const DEFAULT_EVOLUTION_TIMEOUT_MS = 60_000;
export const DEFAULT_AUTO_ACCEPT_HOURS = 48;
export const DEFAULT_LOW_SCORE_THRESHOLD = 0.5;
