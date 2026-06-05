export interface BackendConfig {
  port: number;
  host: string;
  dataDir: string;
  workspaceRoot: string;
  templateDir: string;
  authToken: string;
  maxConcurrentRuns: number;
  anthropicApiKey: string;
  shutdownTimeoutMs: number;
}

const DEFAULTS: Partial<BackendConfig> = {
  port: 3000,
  host: "127.0.0.1",
  maxConcurrentRuns: 8,
  shutdownTimeoutMs: 30_000,
};

export function loadConfig(env: typeof process.env = process.env): BackendConfig {
  const dataDir = env.BACKEND_DATA_DIR ?? "./.backend-data";

  const authToken = env.BACKEND_AUTH_TOKEN;
  if (!authToken) throw new Error("BACKEND_AUTH_TOKEN is required");

  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");

  return {
    port: Number(env.BACKEND_PORT) || DEFAULTS.port!,
    host: env.BACKEND_HOST ?? DEFAULTS.host!,
    dataDir,
    workspaceRoot: env.BACKEND_WORKSPACE_ROOT ?? `${dataDir}/workspaces`,
    templateDir: env.BACKEND_TEMPLATE_DIR ?? `${dataDir}/templates`,
    authToken,
    maxConcurrentRuns: Number(env.BACKEND_MAX_CONCURRENT) || DEFAULTS.maxConcurrentRuns!,
    anthropicApiKey,
    shutdownTimeoutMs:
      Number(env.BACKEND_SHUTDOWN_TIMEOUT_MS) || DEFAULTS.shutdownTimeoutMs!,
  };
}
