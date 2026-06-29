import type { Env } from "@my-agent-team/config";
import { parseEnv } from "@my-agent-team/config";

export interface BackendConfig {
  port: number;
  host: string;
  dataDir: string;
  workspaceRoot: string;
  templateDir: string;
  authToken: string;
  maxConcurrentRuns: number;
  anthropicApiKey: string;
  anthropicBaseUrl?: string;
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

/**
 * Load backend config from validated environment (single source: parseEnv).
 * Computed defaults (like dataDir relative to this file) are applied here.
 */
export function loadConfig(env: Env = parseEnv(process.env)): BackendConfig {
  const dataDir = env.BACKEND_DATA_DIR ?? `${import.meta.dir}/../.backend-data`;

  const anthropicApiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required");

  return {
    port: env.BACKEND_PORT,
    host: env.BACKEND_HOST,
    dataDir,
    workspaceRoot: env.BACKEND_WORKSPACE_ROOT ?? `${dataDir}/workspaces`,
    templateDir: env.BACKEND_TEMPLATE_DIR ?? `${dataDir}/templates`,
    authToken: env.BACKEND_AUTH_TOKEN,
    maxConcurrentRuns: env.BACKEND_MAX_CONCURRENT,
    anthropicApiKey,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
    shutdownTimeoutMs: env.BACKEND_SHUTDOWN_TIMEOUT_MS,
    heartbeatIntervalMs: env.BACKEND_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: env.BACKEND_HEARTBEAT_TIMEOUT_MS,
    cancelGraceMs: env.BACKEND_CANCEL_GRACE_MS,
    reaperIntervalMs: env.BACKEND_REAPER_INTERVAL_MS,
    stepStallTimeoutMs: env.BACKEND_STEP_STALL_TIMEOUT_MS,
  };
}
