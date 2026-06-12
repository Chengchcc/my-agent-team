import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Tool } from "@my-agent-team/core";
import {
  type Agent,
  type Checkpointer,
  consoleLogger,
  createAgent,
  inMemoryCheckpointer,
  type Logger,
  type Plugin,
  sqliteCheckpointer,
} from "@my-agent-team/framework";
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import { taskGuardPlugin } from "@my-agent-team/plugin-task-guard";
import type { WorkspaceRoots } from "@my-agent-team/tools-common";
import {
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  withWorkspace,
  writeTool,
} from "@my-agent-team/tools-common";
import type { WorkspaceHandle } from "@my-agent-team/workspace-fs";
import { bootstrap } from "./bootstrap.js";

function toWorkspaceRoots(ws: WorkspaceHandle): WorkspaceRoots {
  return { privateRoot: ws.privateRoot, posixRoots: ws.posixRoots };
}

function checkDuplicateNames(
  kind: string,
  defaults: readonly { name: string }[],
  extras: readonly { name: string }[],
): void {
  const seen = new Set(defaults.map((d) => d.name));
  for (const e of extras) {
    if (seen.has(e.name)) {
      throw new Error(
        `${kind} name collision: '${e.name}' in extra${kind}s conflicts with a built-in ${kind}`,
      );
    }
    seen.add(e.name);
  }
}

export interface GenericAgentOptions {
  workspace: WorkspaceHandle;

  /** Pre-constructed ChatModel instance (adapter chosen by caller). */
  model: Parameters<typeof createAgent>[0]["model"];

  /** Thread identifier. Same thread reuses checkpointer history. Defaults to random uuid. */
  threadId?: string;

  /** Permission mode. Default 'ask'. M6 passes through to framework; enforcement lands in M8. */
  permissionMode?: "ask" | "auto" | "deny";

  /** Injectable logger / checkpointer. Default logger = console, default checkpointer = sqlite. */
  logger?: Logger;
  checkpointer?: Checkpointer | "memory" | "sqlite";

  /** When checkpointer is sqlite (or default), use this Database instance instead of opening workspace file. */
  checkpointerDb?: Database;

  /** Additional user-defined plugins / tools. Merged with defaults; duplicate names fail fast. */
  extraPlugins?: readonly Plugin[];
  extraTools?: readonly Tool[];
}

function resolveCheckpointer(
  workspace: string,
  checkpointer?: Checkpointer | "memory" | "sqlite",
  checkpointerDb?: Database,
): Checkpointer {
  // Explicit Checkpointer instance passed — use directly
  if (checkpointer && typeof checkpointer !== "string") return checkpointer;

  // "memory" alias — use in-memory (old default, for backward compat)
  if (checkpointer === "memory") return inMemoryCheckpointer();

  // "sqlite" or default — use sqlite with workspace file or injected db
  if (checkpointerDb) return sqliteCheckpointer({ db: checkpointerDb });

  // Ensure .checkpoints/ directory exists in workspace
  const cpDir = path.join(workspace, ".checkpoints");
  mkdirSync(cpDir, { recursive: true });
  return sqliteCheckpointer({ db: path.join(cpDir, "db.sqlite") });
}

export async function createGenericAgent(opts: GenericAgentOptions): Promise<Agent> {
  const {
    workspace,
    model,
    threadId,
    permissionMode: _permissionMode = "ask",
    logger: _logger,
    checkpointer: _checkpointer,
    checkpointerDb,
  } = opts;
  const lg = _logger ?? consoleLogger();
  const root = workspace.privateRoot;

  // 1. Bootstrap: read workspace files via WorkspaceFS → compose systemPrompt
  const systemPrompt = await bootstrap(workspace.fs, lg);

  // 2. Default 6 built-in file tools with multi-root sandbox
  const sandbox = toWorkspaceRoots(workspace);
  const defaultTools: Tool[] = [readTool, writeTool, editTool, bashTool, grepTool, globTool].map(
    (t) => withWorkspace(t, sandbox),
  );

  // 3. Default 2 plugins with conventional paths
  const defaultPlugins: Plugin[] = [
    fsMemoryPlugin({ dir: root }),
    progressiveSkillPlugin({ dir: path.join(root, "skills") }),
    taskGuardPlugin({ model }),
  ];

  // 4. Merge extras (duplicate names fail-fast)
  checkDuplicateNames("tool", defaultTools, opts.extraTools ?? []);
  checkDuplicateNames("plugin", defaultPlugins, opts.extraPlugins ?? []);
  const tools = [...defaultTools, ...(opts.extraTools ?? [])];
  const plugins = [...defaultPlugins, ...(opts.extraPlugins ?? [])];

  // 5. Resolve checkpointer (default → sqlite with workspace file)
  const checkpointer = resolveCheckpointer(root, _checkpointer, checkpointerDb);

  // 6. Wire up framework
  return createAgent({
    model,
    systemPrompt,
    tools,
    plugins,
    threadId,
    logger: lg,
    checkpointer,
  });
}
