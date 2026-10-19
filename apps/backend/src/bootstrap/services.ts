import type { Database } from "bun:sqlite";
import type { McpClientManager } from "@chengchenccc/adapter-mcp";
import { createMcpClientManager } from "@chengchenccc/adapter-mcp";
import type { BackendConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { LarkBotRegistry } from "../features/lark-bot/index.js";
import { createLarkBotRegistry } from "../features/lark-bot/lark-bot-registry-factory.js";
import { RuntimeOpsStore } from "../features/runtime-ops/index.js";
import type { SettingsService } from "../features/settings/index.js";
import { createSettingsService, sqliteSettingsAdapter } from "../features/settings/index.js";
import { openDb } from "../infra/sqlite/db.js";

export interface BackendServices {
  config: BackendConfig;
  db: Database;
  settingsSvc: SettingsService;
  mcpClientManager: McpClientManager;
  opsStore: RuntimeOpsStore;
  larkBotRegistry: LarkBotRegistry;
}

export function createBackendServices(
  config?: BackendConfig,
  opts?: { larkBotRegistry?: LarkBotRegistry },
): BackendServices {
  const cfg = config ?? loadConfig();
  const db = openDb(`${cfg.dataDir}/backend.db`, { migrationsDir: cfg.migrationsDir });

  const settingsSvc = createSettingsService({
    port: sqliteSettingsAdapter(db),
    config: cfg,
  });

  // A url MCP server is fetched with THIS process's network position, so the
  // guard's strictness follows the bind address: on loopback a private target
  // is the normal case (the product's own MCP servers are 127.0.0.1), while a
  // backend reachable off-host must treat it as SSRF (security debt, network
  // deployment). Metadata endpoints are refused either way, inside the guard.
  const loopbackBind = cfg.host === "127.0.0.1" || cfg.host === "::1" || cfg.host === "localhost";
  const mcpClientManager = createMcpClientManager({ allowPrivateHosts: loopbackBind });
  const opsStore = new RuntimeOpsStore(db);

  const larkBotRegistry = createLarkBotRegistry(cfg, opts?.larkBotRegistry);

  return {
    config: cfg,
    db,
    settingsSvc,
    mcpClientManager,
    opsStore,
    larkBotRegistry,
  };
}
