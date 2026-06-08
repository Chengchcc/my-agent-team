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
  /** M9: heartbeat write interval in ms (runner entry) */
  heartbeatIntervalMs: number;
  /** M9: heartbeat timeout in ms (backend marks interrupted). Default 60s (M11: raised from 20s). */
  heartbeatTimeoutMs: number;
  /** M9: grace period after SIGTERM before SIGKILL */
  cancelGraceMs: number;
  /** M11: running reaper scan interval in ms. Default min(heartbeatTimeoutMs/2, 30_000). */
  reaperIntervalMs: number;
  /** M11: secondary stall check in ms before reaper confirms dead (only BackendConfig, not AgentSpec). Default 300_000. */
  stepStallTimeoutMs: number;
}

export function loadConfig(env: typeof process.env = process.env): BackendConfig {
  const dataDir = env.BACKEND_DATA_DIR ?? "./.backend-data";

  const authToken = env.BACKEND_AUTH_TOKEN;
  if (!authToken) throw new Error("BACKEND_AUTH_TOKEN is required");

  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");

  return {
    port: Number(env.BACKEND_PORT) || 3000,
    host: env.BACKEND_HOST ?? "127.0.0.1",
    dataDir,
    workspaceRoot: env.BACKEND_WORKSPACE_ROOT ?? `${dataDir}/workspaces`,
    templateDir: env.BACKEND_TEMPLATE_DIR ?? `${dataDir}/templates`,
    authToken,
    maxConcurrentRuns: Number(env.BACKEND_MAX_CONCURRENT) || 8,
    anthropicApiKey,
    shutdownTimeoutMs: Number(env.BACKEND_SHUTDOWN_TIMEOUT_MS) || 30_000,
    heartbeatIntervalMs: Number(env.BACKEND_HEARTBEAT_INTERVAL_MS) || 5_000,
    heartbeatTimeoutMs: Number(env.BACKEND_HEARTBEAT_TIMEOUT_MS) || 60_000,
    cancelGraceMs: Number(env.BACKEND_CANCEL_GRACE_MS) || 5_000,
    reaperIntervalMs: Number(env.BACKEND_REAPER_INTERVAL_MS) || 30_000,
    stepStallTimeoutMs: Number(env.BACKEND_STEP_STALL_TIMEOUT_MS) || 300_000,
  };
}
