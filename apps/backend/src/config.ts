import { resolve } from "node:path";
import type { Env } from "@chengchenccc/config";
import { parseEnv } from "@chengchenccc/config";

export interface BackendConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Drizzle migrations folder override (bundled artifact). Absent = the
   *  source-relative default, which is right for dev and tests. */
  migrationsDir?: string;
  workspaceRoot: string;
  templateDir: string;
  authToken: string;
  maxConcurrentRuns: number;
  cancelGraceMs: number;
  /** Wall-clock cap on a run: the dispatch watchdog stops the backend and
   *  settles the run aborted when it exceeds this. */
  runTimeoutMs: number;
  /** Root of the stack's file resources (skills/, knowledge-packs/,
   *  workflow-showcase/). Defaults to the repo root — what a source checkout
   *  has; a packaged stack ships resources/ and points this at it. */
  resourcesDir: string;
  /** Builtin skills seed source (`<resources>/skills`). */
  builtinSkillsDir: string;
  /** Builtin knowledge pack seed source (`<resources>/knowledge-packs`). */
  knowledgePacksDir: string;
  /** Showcase workflow seeds (`<resources>/workflow-showcase`). */
  workflowShowcaseDir: string;
  /** Oma executable (spawned per Run). Defaults to "oma"
   *  on PATH; tests point it at the Bun runtime + app entry source. */
  omaBin?: string;
  /** permissionMode=auto classifier model forwarded to the oma child
   *  (OMA_PERMISSION_CLASSIFIER_MODEL). Absent = the run's model. */
  omaPermissionClassifierModel?: string;
  /** Knowledge recall MCP server entry (ADR 0022). Optional: exotic
   *  deployments override; otherwise dev uses source, prod uses dist. */
  knowledgeMcpServerBin?: string;
  ompBin?: string;
  piBin?: string;
  piMcpAdapterPath?: string;
  claudeBin?: string;
  claudePermissionMode?: string;
  productToolsMcpUrl?: string;
  smokeCron?: string;
  /** Comma-separated built-in MCP servers to inject into agent workspaces
   *  (product-tools, workflow). Absent = product-tools only. */
  enabledMcpServers?: string;
  /** H2: workflow script nodes execute unattended code — opt-in. */
  workflowScriptsEnabled: boolean;
  /** H2: directories the workflow script sandbox must not read. */
  workflowScriptDenyReadDirs: string[];
}

/**
 * Load backend config from validated environment (single source: parseEnv).
 * Computed defaults (like dataDir relative to this file) are applied here.
 */
export function loadConfig(env: Env = parseEnv(process.env)): BackendConfig {
  // Relative BACKEND_DATA_DIR (e.g. ./.backend-data) resolves against the
  // process cwd. Absolute everywhere: the workspace bridge writes symlink
  // targets from these paths, and a relative source resolves against the
  // LINK'S directory — producing dead links in agent workspaces.
  const dataDir = resolve(
    process.cwd(),
    env.BACKEND_DATA_DIR ?? `${import.meta.dir}/../.backend-data`,
  );

  // A packaged stack ships resources/ next to the entry; a source checkout IS
  // the resources root (import.meta.dir = apps/backend/src).
  const resourcesDir = env.BACKEND_RESOURCES_DIR
    ? resolve(process.cwd(), env.BACKEND_RESOURCES_DIR)
    : resolve(import.meta.dir, "../../..");

  return {
    port: env.BACKEND_PORT,
    host: env.BACKEND_HOST,
    dataDir,
    migrationsDir: env.BACKEND_MIGRATIONS_DIR,
    workspaceRoot: resolve(process.cwd(), env.BACKEND_WORKSPACE_ROOT ?? `${dataDir}/workspaces`),
    templateDir: resolve(process.cwd(), env.BACKEND_TEMPLATE_DIR ?? `${dataDir}/templates`),
    authToken: env.BACKEND_AUTH_TOKEN,
    maxConcurrentRuns: env.BACKEND_MAX_CONCURRENT,
    cancelGraceMs: env.BACKEND_CANCEL_GRACE_MS,
    runTimeoutMs: env.BACKEND_RUN_TIMEOUT_MS ?? 30 * 60_000,
    resourcesDir,
    builtinSkillsDir: resolve(resourcesDir, "skills"),
    knowledgePacksDir: resolve(resourcesDir, "knowledge-packs"),
    workflowShowcaseDir: resolve(resourcesDir, "workflow-showcase"),
    omaBin: env.OMA_BIN,
    omaPermissionClassifierModel: env.OMA_PERMISSION_CLASSIFIER_MODEL,
    knowledgeMcpServerBin: env.KNOWLEDGE_MCP_SERVER_BIN,
    piBin: env.PI_BIN,
    piMcpAdapterPath: env.PI_MCP_ADAPTER_PATH,
    claudeBin: env.CLAUDE_BIN,
    claudePermissionMode: env.CLAUDE_PERMISSION_MODE,
    productToolsMcpUrl: env.PRODUCT_TOOLS_MCP_URL,
    smokeCron: env.SMOKE_CRON,
    enabledMcpServers: env.ENABLED_MCP_SERVERS,
    workflowScriptsEnabled:
      env.WORKFLOW_SCRIPTS_ENABLED === "1" || env.WORKFLOW_SCRIPTS_ENABLED === "true",
    workflowScriptDenyReadDirs: [
      dataDir,
      resolve(process.cwd(), ".env"),
      ...(env.WORKFLOW_SANDBOX_DENY_READ ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ],
  };
}
