import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@chengchenccc/message";
import type { CoordinationRegistry } from "../coordination/registry.js";
import { debugLog } from "../debug-log.js";
import type { Plugin, PluginTool } from "../index.js";
import { isFileTrusted, readTrustedPlugins } from "../plugins/plugin-trust.js";
import type { RuntimeKnobs } from "../settings/project-settings.js";
import type { BashSandbox } from "../tools/bash-sandbox.js";
import {
  createBashTool,
  createBrowserTool,
  createDdgWebSearchPort,
  createEditTool,
  createEvalTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createPortWebFetchTool,
  createPortWebSearchTool,
  createReadImageTool,
  createReadTool,
  createStdWebFetchPort,
  createTreeTool,
  createWriteTool,
  MAX_BASH_TIMEOUT_MS,
  MAX_EVAL_TIMEOUT_MS,
} from "../tools/index.js";
import {
  type McpMountReport,
  mountWorkspaceMcpServers,
  withCallTimeout,
} from "../tools/mcp-mount.js";
import type { RunRuntimeDeps } from "./run-runtime.js";

/** Default native tool timeout (ms) for file/web/bash unless overridden. */
const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 30_000;

function resolveNativeToolTimeout(defaultMs: number, maxToolTimeoutMs?: number): number {
  const cap = maxToolTimeoutMs ?? 0;
  if (Number.isFinite(cap) && cap > 0) return Math.min(defaultMs, cap);
  return defaultMs;
}

async function withToolTimeout(
  tool: PluginTool,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  options: { callId?: string; onOutput?: (partial: string) => void } | undefined,
  defaultMs: number,
  maxToolTimeoutMs?: number,
): Promise<Readonly<Record<string, unknown>>> {
  const timeoutMs = resolveNativeToolTimeout(defaultMs, maxToolTimeoutMs);
  if (timeoutMs <= 0) return tool.execute(input, signal, options);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await withCallTimeout(
      tool.execute(input, controller.signal, options),
      tool.name,
      timeoutMs,
      signal,
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("timed out after")) throw err;
      if (tool.name !== "bash") throw err;
      throw new Error(
        `${message}. If the command waits for input (password, confirmation), it needs the ` +
          "interactive pty console: re-run it with pty: true, or use a non-interactive form " +
          "(e.g. key-based ssh/scp).",
      );
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Wrapper deadline per tool: bash/eval enforce their own deadline so they get
 *  a backstop at their ceiling rather than the generic 30s default. */
export function wrapperBackstopMs(toolName: string): number {
  if (toolName === "bash") return MAX_BASH_TIMEOUT_MS;
  if (toolName === "eval") return MAX_EVAL_TIMEOUT_MS;
  return DEFAULT_NATIVE_TOOL_TIMEOUT_MS;
}

function wrapNativeTool(
  tool: PluginTool,
  defaultMs = DEFAULT_NATIVE_TOOL_TIMEOUT_MS,
  maxToolTimeoutMs?: number,
): PluginTool {
  return {
    ...tool,
    timeoutMs: resolveNativeToolTimeout(defaultMs, maxToolTimeoutMs),
    execute: (input, signal, options) =>
      withToolTimeout(tool, input, signal, options, defaultMs, maxToolTimeoutMs),
  };
}

/** Adapt a tools-common `Tool` to the runtime's `PluginTool`. */
export function toPluginTool(t: Tool): PluginTool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    executionMode: t.executionMode,
    describeStart: t.describeStart,
    describeResult: t.describeResult,
    async execute(args, signal, options) {
      const result = await t.execute(args, signal, options);
      return { ...result };
    },
  };
}

/** Tool-table stage of the Run assembly: native file/bash/web/eval tools,
 *  .mcp.json + plugin MCP mounting, per-tool timeout wrapping. */
export async function buildNativeToolStage(
  deps: RunRuntimeDeps,
  ctx: {
    knobs: RuntimeKnobs;
    bashSandbox: BashSandbox | undefined;
    scope: string;
    registry: CoordinationRegistry;
  },
): Promise<{
  agentTools: PluginTool[];
  nativeToolsPlugin: Plugin;
  closeMounted: () => Promise<void>;
  mcpReports: readonly McpMountReport[];
  mountedToolNames: ReadonlySet<string>;
}> {
  const { knobs, bashSandbox, scope, registry } = ctx;
  const fileFreshness = knobs.editFreshness ?? "require";
  const agentTools: PluginTool[] = [
    toPluginTool(createReadTool({ cwd: deps.workspaceRoot, freshness: fileFreshness })),
    toPluginTool(createReadImageTool({ cwd: deps.workspaceRoot })),
    toPluginTool(createLsTool({ cwd: deps.workspaceRoot })),
    toPluginTool(createTreeTool({ cwd: deps.workspaceRoot })),
    toPluginTool(createGlobTool({ workspaceRoot: deps.workspaceRoot })),
    toPluginTool(createGrepTool({ workspaceRoot: deps.workspaceRoot })),
  ];
  if (deps.workspaceAccess === "read_write") {
    agentTools.push(
      toPluginTool(
        createWriteTool({
          cwd: deps.workspaceRoot,
          freshness: fileFreshness,
          ...(deps.planMode ? { planMode: deps.planMode } : {}),
        }),
      ),
    );
    agentTools.push(
      toPluginTool(
        createEditTool({
          cwd: deps.workspaceRoot,
          freshness: fileFreshness,
          ...(deps.planMode ? { planMode: deps.planMode } : {}),
        }),
      ),
    );
    const bashToolOpts: {
      workspaceRoot: string;
      scope: string;
      sandbox?: BashSandbox;
      timeouts?: { bashTimeoutMs?: number; maxToolTimeoutMs?: number };
      registry?: CoordinationRegistry;
      ptyConsole?: (
        command: string,
        cwd: string,
        env: Record<string, string>,
      ) => Promise<{ exitCode: number | null; tail: string; killed: boolean }>;
    } = { workspaceRoot: deps.workspaceRoot, scope, timeouts: knobs, registry };
    if (bashSandbox) bashToolOpts.sandbox = bashSandbox;
    if (deps.bashPtyConsole) bashToolOpts.ptyConsole = deps.bashPtyConsole;
    agentTools.push(toPluginTool(createBashTool(bashToolOpts)));
    if (!deps.planMode) {
      agentTools.push(
        toPluginTool(
          createEvalTool({
            workspaceRoot: deps.workspaceRoot,
            scope,
            registry,
            ...(knobs.evalTimeoutMs !== undefined ? { timeoutMs: knobs.evalTimeoutMs } : {}),
            ...(bashSandbox
              ? {
                  isolation: {
                    noNetwork: true,
                    denyReadDirs: (process.env.OMA_DENY_WRITE_PATHS ?? "")
                      .split(",")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  },
                }
              : {}),
          }),
        ),
      );
      agentTools.push(
        toPluginTool(
          createBrowserTool({
            workspaceRoot: deps.workspaceRoot,
            ...(knobs.browserLocalNetwork ? { allowLocalNetwork: true } : {}),
          }),
        ),
      );
    }
  }
  let includeWorkspaceMcp = true;
  if (deps.gateWorkspaceMcp) {
    const mcpJsonPath = join(deps.workspaceRoot, ".mcp.json");
    if (existsSync(mcpJsonPath) && !isFileTrusted(mcpJsonPath, readTrustedPlugins())) {
      includeWorkspaceMcp = false;
      debugLog("oma", `workspace .mcp.json untrusted; servers not mounted (use /mcp trust)`);
    }
  }
  const mounted = await mountWorkspaceMcpServers(
    deps.workspaceRoot,
    new Set(agentTools.map((t) => t.name)),
    deps.pluginMcpServers ?? [],
    includeWorkspaceMcp,
    {
      ...(knobs.mcpTimeoutMs !== undefined ? { mcpTimeoutMs: knobs.mcpTimeoutMs } : {}),
      ...(knobs.maxToolTimeoutMs !== undefined ? { maxToolTimeoutMs: knobs.maxToolTimeoutMs } : {}),
    },
    deps.excludeMcpServerNames,
  );
  if (knobs.disableWeb !== true) {
    agentTools.push(
      createPortWebSearchTool(deps.webSearch ?? createDdgWebSearchPort()),
      createPortWebFetchTool(deps.webFetch ?? createStdWebFetchPort()),
    );
  }
  const nativeTools = agentTools.map((t) =>
    wrapNativeTool(t, wrapperBackstopMs(t.name), knobs.maxToolTimeoutMs),
  );
  const nativeToolsPlugin: Plugin = {
    name: "native-tools",
    tools: [...nativeTools, ...mounted.tools],
  };
  return {
    agentTools,
    nativeToolsPlugin,
    closeMounted: mounted.close,
    mcpReports: mounted.reports,
    mountedToolNames: new Set([
      ...mounted.tools.map((t) => t.name),
      ...(deps.codePlugins ?? []).flatMap((plugin) => (plugin.tools ?? []).map((t) => t.name)),
    ]),
  };
}

/** Is a tool with this leaf name among the mounted tools? */
export function mountedProvidesLeaf(
  stage: { mountedToolNames: ReadonlySet<string> },
  leaf: string,
): boolean {
  for (const name of stage.mountedToolNames) {
    if ((name.split("__").pop() ?? name) === leaf) return true;
  }
  return false;
}
