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
} from "@my-agent-team/framework";
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import {
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  writeTool,
} from "@my-agent-team/tools-common";
import { bootstrap } from "./bootstrap.js";

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
  /** Workspace root directory (absolute path recommended). Base for all built-in tools/plugins. */
  workspace: string;

  /** Pre-constructed ChatModel instance (adapter chosen by caller). */
  model: Parameters<typeof createAgent>[0]["model"];

  /** Thread identifier. Same thread reuses checkpointer history. Defaults to random uuid. */
  threadId?: string;

  /** Permission mode. Default 'ask'. M6 passes through to framework; enforcement lands in M8. */
  permissionMode?: "ask" | "auto" | "deny";

  /** Injectable logger / checkpointer, defaults to console + in-memory. */
  logger?: Logger;
  checkpointer?: Checkpointer;

  /** Additional user-defined plugins / tools. Merged with defaults; duplicate names fail fast. */
  extraPlugins?: readonly Plugin[];
  extraTools?: readonly Tool[];
}

export async function createGenericAgent(opts: GenericAgentOptions): Promise<Agent> {
  const {
    workspace,
    model,
    threadId,
    permissionMode: _permissionMode = "ask",
    logger: _logger,
    checkpointer: _checkpointer,
  } = opts;
  const lg = _logger ?? consoleLogger();

  // 1. Bootstrap: read workspace files → compose systemPrompt
  const systemPrompt = await bootstrap(workspace, lg);

  // 2. Default 6 built-in file tools (domain-neutral, needed by all workspace agents)
  // bashTool wrapped to enforce cwd=workspace per architecture doc §四 contract
  const bashWithCwd: Tool = {
    ...bashTool,
    execute(input) {
      return bashTool.execute({ ...(input as Record<string, unknown>), cwd: workspace });
    },
  };
  const defaultTools: Tool[] = [readTool, writeTool, editTool, bashWithCwd, grepTool, globTool];

  // 3. Default 2 plugins with conventional paths
  const defaultPlugins: Plugin[] = [
    fsMemoryPlugin({ dir: workspace }),
    progressiveSkillPlugin({ dir: path.join(workspace, "skills") }),
  ];

  // 4. Merge extras (duplicate names fail-fast)
  checkDuplicateNames("tool", defaultTools, opts.extraTools ?? []);
  checkDuplicateNames("plugin", defaultPlugins, opts.extraPlugins ?? []);
  const tools = [...defaultTools, ...(opts.extraTools ?? [])];
  const plugins = [...defaultPlugins, ...(opts.extraPlugins ?? [])];

  // 5. Wire up framework
  return createAgent({
    model,
    systemPrompt,
    tools,
    plugins,
    threadId,
    logger: lg,
    checkpointer: _checkpointer ?? inMemoryCheckpointer(),
  });
}
