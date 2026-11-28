import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { sanitizeServerName } from "@chengchenccc/adapter-mcp";
import { decodeEnvList, MCP_EXPANDABLE_VARS_ENV } from "@chengchenccc/message";
import type { PluginTool } from "../index.js";
import type { PluginMcpConfig } from "../plugins/plugin-resolve.js";
import { isFileTrusted, readTrustedPlugins } from "../plugins/plugin-trust.js";
import { killProcessTree } from "../runtime/process-tree.js";
import { isMetadataHost, parseHttpUrl, resolveHostAddresses } from "./url-guard.js";

/** Generic .mcp.json mounting (ADR 0022): the workspace bridge writes one
 *  .mcp.json (user servers + spawner-bridged servers); the child mounts
 *  every server. Tool names that collide with the native tool table are
 *  skipped (the native table wins). One client per server, kept alive for
 *  the run. */

interface McpJsonServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Per-request timeout for tool calls on this server (ms). The SDK's
   *  default is 60s, which silently kills long-parking tools — the HITL ask
   *  parks for as long as the human needs, so product-tools declares a
   *  timeout above its own ask deadline. Absent = SDK default. */
  timeoutMs?: number;
}

interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { text?: string; uri?: string };
}

interface McpCallResult {
  content?: McpContentItem[];
  isError?: boolean;
}

/** Model-facing cap on text returned from a single MCP tool call. */
const MAX_MCP_RESULT_CHARS = 64_000;
/** Max base64 chars accepted per MCP image block (~5MB raw image). */
const MAX_MCP_IMAGE_BASE64 = 7 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Validate a URL-based MCP server: requires http(s) and refuses cloud metadata
 *  endpoints (including DNS answers), while allowing loopback/LAN servers. */
export async function assertSafeMcpUrl(rawUrl: string): Promise<URL> {
  const parsed = parseHttpUrl(rawUrl);
  if (isMetadataHost(parsed.hostname)) {
    throw new Error(`refused MCP URL ${rawUrl}: cloud metadata endpoints are blocked`);
  }
  const isLiteralIp =
    parsed.hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname);
  if (!isLiteralIp) {
    const addrs = await resolveHostAddresses(parsed.hostname);
    if (addrs.some((a) => isMetadataHost(a))) {
      throw new Error(`refused MCP URL ${rawUrl}: resolves to a cloud metadata address`);
    }
  }
  return parsed;
}

function buildStdioEnv(
  serverEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!serverEnv) return undefined;
  // Preserve essential runtime lookup vars (PATH/HOME/LANG/TMPDIR) so a server
  // config that sets one custom env var does not break `npx`/`node`/`bun`.
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    const val = process.env[key];
    if (val !== undefined) base[key] = val;
  }
  for (const [k, v] of Object.entries(serverEnv)) {
    base[k] = expandEnvVars(v);
  }
  return base;
}

type ToolArguments = Record<string, unknown>;

interface McpClientLike {
  callTool(params: {
    name: string;
    arguments?: ToolArguments;
    /** MCP implementation metadata; the product dispatcher reads
     *  _meta.identity.callId as the write idempotency key (#26). */
    _meta?: Record<string, unknown>;
  }): Promise<McpCallResult>;
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }>;
  close(): Promise<void>;
}

function loadMcpConfig(workspaceRoot: string): Record<string, McpJsonServer> {
  const path = join(workspaceRoot, ".mcp.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, McpJsonServer>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** Expand ${VAR} placeholders in .mcp.json headers/env. ALLOWLIST ONLY,
 *  and the list is INJECTED (spawner-declared env var; the name and the
 *  comma codec are single-sourced in agent-contract env.ts): .mcp.json
 *  lives in the workspace and is writable by the agent itself — free
 *  expansion of process env would let a prompt-injected write exfiltrate
 *  provider keys / run tokens to any configured SSE URL (proven P0,
 *  2026-09-07). oma itself holds no product names; everything outside the
 *  injected list resolves to "" with a warning. Read per call so tests
 *  (one process) can scope it. */
function expandableEnvVars(): Set<string> {
  return new Set(decodeEnvList(process.env[MCP_EXPANDABLE_VARS_ENV]));
}
function expandEnvVars(value: string): string {
  const allowed = expandableEnvVars();
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) => {
    if (!allowed.has(name)) {
      console.warn(`[mcp-mount] refusing to expand non-allowlisted placeholder ${whole}`);
      return "";
    }
    return process.env[name] ?? "";
  });
}

/** Validate a stdio server command BEFORE spawn (P1). .mcp.json lives in
 *  the workspace and is agent-writable; a missing/non-executable command
 *  must surface as a clear per-server failure ("server absent"), not a
 *  deep SDK spawn error. Returns null when the command resolves. */
export function validateMcpCommand(command: string, workspaceRoot: string): string | null {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const resolved = isAbsolute(command) ? command : join(workspaceRoot, command);
    if (!existsSync(resolved)) return `command not found: ${command}`;
    if (!statSync(resolved).isFile()) return `command is not a file: ${command}`;
    try {
      accessSync(resolved, constants.X_OK);
    } catch {
      return `command not executable: ${command}`;
    }
    return null;
  }
  // Bare name: search PATH.
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate) && statSync(candidate).isFile()) return null;
  }
  return `command not found on PATH: ${command}`;
}

async function connectServer(
  name: string,
  server: McpJsonServer,
  workspaceRoot: string,
  connectTimeoutMs: number,
  sdkCallTimeoutMs: number,
): Promise<{ client: McpClientLike } | { error: string }> {
  // Declared OUTSIDE the try: the catch must reach it to tear down a
  // half-open connect.
  let bestEffortClose: (() => void) | null = null;
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    // One options object for both transports. The SDK's own 60s default is
    // never relied on: a server that declares how long its tools take (the
    // product-tools ask waits for a human) passes that value down here, and
    // anything else falls back to the mount's call timeout.
    const callOptions = { timeout: server.timeoutMs ?? sdkCallTimeoutMs };
    let stdioRootPid: number | null = null;
    let closeSdk: () => Promise<void>;
    let callTool: McpClientLike["callTool"];
    let listTools: McpClientLike["listTools"];
    // Set the moment a transport+client exist, so a failed/timed-out
    // connect still tears them down: a hung stdio child must not leak
    // per Run (and the SDK's close alone does not cover a half-open
    // connect, so the pid gets killProcessTree'd too).
    if (server.url) {
      const safeUrl = await assertSafeMcpUrl(server.url);
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const headers = server.headers
        ? Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, expandEnvVars(v)]))
        : undefined;
      const transport = new SSEClientTransport(
        safeUrl,
        headers ? { requestInit: { headers } } : undefined,
      );
      const client = new Client({ name: "oma", version: "0.1.0" }, { capabilities: {} });
      bestEffortClose = () => void client.close().catch(() => {});
      // A server that accepts the socket but never answers initialize must
      // not wedge the whole Run assembly (mount runs before the loop starts,
      // so there is no run AbortSignal here — the deadline is the bound).
      await withCallTimeout(client.connect(transport), `mcp connect ${name}`, connectTimeoutMs);
      callTool = (params) =>
        // MCP wire boundary: the SDK returns a wide content union.
        client.callTool(params, undefined, callOptions) as Promise<McpCallResult>;
      listTools = () => client.listTools();
      closeSdk = () => client.close();
    } else if (server.command) {
      const invalid = validateMcpCommand(server.command, workspaceRoot);
      if (invalid) throw new Error(invalid);
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const env = buildStdioEnv(server.env);
      const resolvedCmd =
        !isAbsolute(server.command) &&
        (server.command.includes("/") || server.command.includes("\\"))
          ? join(workspaceRoot, server.command)
          : server.command;
      const transport = new StdioClientTransport({
        command: resolvedCmd,
        args: server.args ?? [],
        cwd: workspaceRoot,
        env,
      });
      const client = new Client({ name: "oma", version: "0.1.0" }, { capabilities: {} });
      bestEffortClose = () => {
        void client.close().catch(() => {});
        const pid = transport.pid;
        if (pid) killProcessTree(pid);
      };
      await withCallTimeout(client.connect(transport), `mcp connect ${name}`, connectTimeoutMs);
      stdioRootPid = transport.pid;
      callTool = (params) =>
        // MCP wire boundary: see the sse branch above.
        client.callTool(params, undefined, callOptions) as Promise<McpCallResult>;
      listTools = () => client.listTools();
      closeSdk = () => client.close();
    } else {
      return { error: "neither url nor command configured" };
    }
    return {
      client: {
        callTool,
        listTools,
        async close() {
          await closeSdk();
          if (stdioRootPid !== null) killProcessTree(stdioRootPid);
        },
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[mcp-mount] server ${name} failed:`, reason);
    bestEffortClose?.();
    return { error: reason };
  }
}

/** One configured server as a listing row (pi's /mcp list). */
export interface McpServerInfo {
  name: string;
  kind: "stdio" | "url" | "invalid";
  detail: string;
}

/** Configured servers from the workspace .mcp.json, sorted by name.
 *  Never throws — a corrupt file yields []. */
export function listMcpServers(workspaceRoot: string): McpServerInfo[] {
  const servers = loadMcpConfig(workspaceRoot);
  return Object.entries(servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => {
      if (server.url) return { name, kind: "url" as const, detail: server.url };
      if (server.command) {
        const problem = validateMcpCommand(server.command, workspaceRoot);
        return {
          name,
          kind: "stdio" as const,
          detail:
            [server.command, ...(server.args ?? [])].join(" ") +
            (problem ? ` — NOT MOUNTED: ${problem}` : ""),
        };
      }
      return { name, kind: "invalid" as const, detail: "no command or url" };
    });
}

const MCP_TEST_TIMEOUT_MS = 10_000;

/** Live-connect one configured server and list its tools (pi's /mcp test).
 *  Refuses untrusted workspace `.mcp.json` files so testing never executes
 *  untrusted stdio commands before explicit `/mcp trust`. Reports failure
 *  reasons; never throws. */
export async function testMcpServer(
  workspaceRoot: string,
  name: string,
  opts?: { skipTrustCheck?: boolean },
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const mcpPath = join(workspaceRoot, ".mcp.json");
  if (
    !opts?.skipTrustCheck &&
    existsSync(mcpPath) &&
    !isFileTrusted(mcpPath, readTrustedPlugins())
  ) {
    return {
      ok: false,
      tools: [],
      error: "workspace .mcp.json is untrusted — run /mcp trust before testing",
    };
  }
  const servers = loadMcpConfig(workspaceRoot);
  const server = servers[name];
  if (!server) {
    return { ok: false, tools: [], error: `no server named "${name}" in .mcp.json` };
  }
  const connected = await connectServer(
    name,
    server,
    workspaceRoot,
    MCP_TEST_TIMEOUT_MS,
    server.timeoutMs ?? MCP_TEST_TIMEOUT_MS,
  );
  if (!("client" in connected)) {
    return {
      ok: false,
      tools: [],
      error: `connect failed (${connected.error})`,
    };
  }
  const { client } = connected;
  try {
    const { tools } = await withCallTimeout(
      client.listTools(),
      `mcp listTools ${name}`,
      MCP_TEST_TIMEOUT_MS,
    );
    return { ok: true, tools: tools.map((t) => t.name) };
  } catch (err) {
    return {
      ok: false,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Default per-call timeout for mounted MCP tools (ms): MCP legitimately
 *  runs longer than file tools. 0 disables the deadline. */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000;

/** Per-call timeout for mounted MCP tools (ms). A hung server must never
 *  block the Run forever. Explicit values (run knobs) win; otherwise the
 *  process env is the deployment default. */
export function mcpCallTimeoutMs(settings?: {
  mcpTimeoutMs?: number;
  maxToolTimeoutMs?: number;
}): number {
  const raw = process.env.OMA_MCP_TIMEOUT_MS;
  const fromEnv = raw === undefined ? DEFAULT_MCP_CALL_TIMEOUT_MS : Number(raw);
  let n =
    settings?.mcpTimeoutMs ?? (Number.isFinite(fromEnv) ? fromEnv : DEFAULT_MCP_CALL_TIMEOUT_MS);
  const capRaw = process.env.OMA_MAX_TOOL_TIMEOUT_MS;
  const envCap = capRaw ? Number(capRaw) : 0;
  const cap = settings?.maxToolTimeoutMs ?? (Number.isFinite(envCap) ? envCap : 0);
  if (Number.isFinite(cap) && cap > 0) n = Math.min(n, cap);
  return n;
}

/** Default budget for the MOUNT phase (connect + tools/list) per server.
 *  The runtime is not accepted until every mount finishes, so a server that
 *  accepts the connection and then says nothing used to eat the much larger
 *  per-call ceiling and delay the whole run's start (2026-09-25). A mount is
 *  a local handshake: seconds, not minutes. */
export const DEFAULT_MCP_MOUNT_TIMEOUT_MS = 30_000;

/** Mount-phase timeout (ms), independent of the per-call one. */
export function mcpMountTimeoutMs(settings?: {
  mountTimeoutMs?: number;
  mcpTimeoutMs?: number;
}): number {
  if (settings?.mountTimeoutMs !== undefined) return settings.mountTimeoutMs;
  return Math.min(DEFAULT_MCP_MOUNT_TIMEOUT_MS, mcpCallTimeoutMs(settings));
}

/** Race a tool call against a wall-clock timeout and the run's abort
 * signal. The losing call keeps running server-side (the MCP SDK's
 * callTool takes no signal) but its result lands nowhere. The Bun timer
 * MUST be cleared or the process lingers — hence the finally. */
export async function withCallTimeout<T>(
  call: Promise<T>,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("Aborted");
  if (timeoutMs <= 0 && !signal) return call;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bail = new Promise<never>((_, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    }
    if (signal) {
      onAbort = () => reject(new Error("Aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([call, bail]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Mount the workspace .mcp.json servers as plugin tools. Never throws;
 *  per-server failures degrade to "server absent". */
export interface McpMountReport {
  readonly server: string;
  readonly ok: boolean;
  readonly toolsCount: number;
  readonly error?: string;
}

export interface MountedMcpServers {
  tools: PluginTool[];
  /** Per-server REAL mount outcome (connect + listTools), in config order. */
  reports: readonly McpMountReport[];
  /** Close every mounted server's transport (kills stdio children). */
  close(): Promise<void>;
}

export async function mountWorkspaceMcpServers(
  workspaceRoot: string,
  nativeNames: ReadonlySet<string>,
  pluginServers: readonly PluginMcpConfig[] = [],
  includeWorkspace = true,
  timeouts?: { mcpTimeoutMs?: number; maxToolTimeoutMs?: number; mountTimeoutMs?: number },
  /** Server names this run already serves over another rail (MCP-over-ACP).
   *  Mounting them here too would create same-named tools and the file-based
   *  one can win the tool table — shadowing the mount that carries the call
   *  identity. Excluded servers are never even attempted. */
  excludeServerNames?: ReadonlySet<string>,
): Promise<MountedMcpServers> {
  const callTimeoutMs = mcpCallTimeoutMs(timeouts);
  const mountTimeoutMs = mcpMountTimeoutMs(timeouts);
  const servers = includeWorkspace
    ? mergeMcpConfigs(workspaceRoot, pluginServers)
    : mergePluginMcpConfigs(pluginServers, workspaceRoot);
  const entries = Object.entries(servers);
  const mountedEntries = await Promise.all(
    entries.map(async ([name, server]) => {
      const safeServer = sanitizeServerName(name);
      if (excludeServerNames?.has(safeServer)) return null;
      // P1: a broken command fails ITS server with the reason, never a
      // half-mounted run.
      if (server.command && !server.url) {
        const invalid = validateMcpCommand(server.command, workspaceRoot);
        if (invalid) {
          return {
            report: { server: name, ok: false, toolsCount: 0, error: invalid } as McpMountReport,
            tools: [] as PluginTool[],
            client: null as McpClientLike | null,
          };
        }
      }
      // A server may declare how long its tools take (the product-tools ask
      // waits for a human). That value must drive BOTH timers: the SDK request
      // option and the wrapper below. Fixing only the SDK left the wrapper's
      // 120s default killing the ask first (observed 2026-09-25).
      const serverCallTimeoutMs = server.timeoutMs ?? callTimeoutMs;
      const connected = await connectServer(
        name,
        server,
        workspaceRoot,
        mountTimeoutMs,
        serverCallTimeoutMs,
      );
      if (!("client" in connected)) {
        return {
          report: {
            server: name,
            ok: false,
            toolsCount: 0,
            error: connected.error,
          } as McpMountReport,
          tools: [] as PluginTool[],
          client: null as McpClientLike | null,
        };
      }
      const client = connected.client;
      let listed: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      try {
        // Same bound as connect: a server that connected but never answers
        // tools/list must fail ITS entry, not hang the assembly.
        listed = (
          await withCallTimeout(client.listTools(), `mcp listTools ${name}`, mountTimeoutMs)
        ).tools;
      } catch (err) {
        console.error(
          `[mcp-mount] listTools ${name} failed:`,
          err instanceof Error ? err.message : err,
        );
        await client.close().catch(() => {});
        return {
          report: {
            server: name,
            ok: false,
            toolsCount: 0,
            error: err instanceof Error ? err.message : String(err),
          } as McpMountReport,
          tools: [] as PluginTool[],
          client: null as McpClientLike | null,
        };
      }
      const serverTools: PluginTool[] = [];
      for (const t of listed) {
        // Register under the canonical mcp__<sanitizedServer>__<tool> name so
        // permission gates match "mcp__" AND provider tool-name schemas accept it.
        const qualified = `mcp__${safeServer}__${t.name}`;
        if (nativeNames.has(qualified) || nativeNames.has(t.name)) continue;
        serverTools.push({
          name: qualified,
          description: t.description ?? `MCP tool ${t.name} (server ${name})`,
          inputSchema: (t.inputSchema ?? { type: "object" }) as PluginTool["inputSchema"],
          timeoutMs: serverCallTimeoutMs,
          async execute(args, signal, options?: { callId?: string }) {
            // The model's tool-use id rides the same metadata the ACP rail
            // carries: a write-type product tool must replay under one
            // identity, or a retry executes as a NEW call (#26 review P1-4).
            const res = await withCallTimeout(
              client.callTool({
                name: t.name,
                arguments: args,
                ...(options?.callId ? { _meta: { identity: { callId: options.callId } } } : {}),
              }),
              `mcp tool ${t.name}`,
              serverCallTimeoutMs,
              signal,
            );
            const textParts: string[] = [];
            const images: Array<{
              type: "image";
              mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
              base64: string;
            }> = [];
            for (const c of res.content ?? []) {
              if (c.type === "text" && c.text) {
                textParts.push(c.text);
              } else if (c.type === "resource" && c.resource?.text) {
                textParts.push(c.resource.text);
              } else if (
                c.type === "image" &&
                typeof c.data === "string" &&
                c.data.length > 0 &&
                c.data.length <= MAX_MCP_IMAGE_BASE64 &&
                typeof c.mimeType === "string" &&
                ALLOWED_IMAGE_MIMES.has(c.mimeType)
              ) {
                images.push({
                  type: "image",
                  mediaType: c.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                  base64: c.data,
                });
              }
            }
            const rawText = textParts.join("\n");
            const text =
              rawText.length > MAX_MCP_RESULT_CHARS
                ? `${rawText.slice(0, MAX_MCP_RESULT_CHARS)}\n... [truncated at ${MAX_MCP_RESULT_CHARS} chars of ${rawText.length}]`
                : rawText;
            if (res.isError) throw new Error(text || `mcp tool ${t.name} failed`);
            if (images.length > 0) {
              return {
                content: text || `[${images.length} image(s) returned by ${t.name}]`,
                images,
              };
            }
            return { content: text };
          },
        } as PluginTool);
      }
      return {
        report: { server: name, ok: true, toolsCount: listed.length } as McpMountReport,
        tools: serverTools,
        client,
      };
    }),
  );

  const tools: PluginTool[] = [];
  const reports: McpMountReport[] = [];
  const clients: McpClientLike[] = [];
  for (const entry of mountedEntries) {
    if (!entry) continue;
    reports.push(entry.report);
    tools.push(...entry.tools);
    if (entry.client) clients.push(entry.client);
  }
  return {
    tools,
    reports,
    async close() {
      await Promise.allSettled(clients.map((c) => c.close().catch(() => {})));
    },
  };
}

/** Expand ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR} in a plugin server
 *  config (spec: Claude plugin .mcp.json compatibility) and export both as
 *  env vars to the spawned server process. */

export function substitutePluginVars(
  server: McpJsonServer,
  ctx: { pluginRoot: string; workspaceRoot: string },
): McpJsonServer {
  const sub = (s: string): string =>
    s
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", ctx.pluginRoot)
      .replaceAll("${CLAUDE_PROJECT_DIR}", ctx.workspaceRoot);
  const out: McpJsonServer = { ...server };
  if (server.command) out.command = sub(server.command);
  if (server.args) out.args = server.args.map(sub);
  if (server.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) env[k] = sub(String(v));
    env.CLAUDE_PLUGIN_ROOT = ctx.pluginRoot;
    env.CLAUDE_PROJECT_DIR = ctx.workspaceRoot;
    out.env = env;
  }
  if (server.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.headers)) headers[k] = sub(String(v));
    out.headers = headers;
  }
  return out;
}

/** Workspace .mcp.json wins on name conflicts (spec conflict matrix);
 *  plugin servers keep resolver order otherwise. */
export function mergeMcpConfigs(
  workspaceRoot: string,
  plugins: readonly PluginMcpConfig[],
): Record<string, McpJsonServer> {
  const merged: Record<string, McpJsonServer> = loadMcpConfig(workspaceRoot);
  for (const p of plugins) {
    for (const [name, raw] of Object.entries(p.servers)) {
      if (name in merged) continue;
      if (typeof raw !== "object" || raw === null) continue;
      merged[name] = substitutePluginVars(raw as McpJsonServer, {
        pluginRoot: p.pluginRoot,
        workspaceRoot,
      });
    }
  }
  return merged;
}

/** Plugin servers only (workspace .mcp.json gated off — standalone trust). */
export function mergePluginMcpConfigs(
  plugins: readonly PluginMcpConfig[],
  workspaceRoot: string,
): Record<string, McpJsonServer> {
  const merged: Record<string, McpJsonServer> = {};
  for (const p of plugins) {
    for (const [name, raw] of Object.entries(p.servers)) {
      if (name in merged) continue;
      if (typeof raw !== "object" || raw === null) continue;
      merged[name] = substitutePluginVars(raw as McpJsonServer, {
        pluginRoot: p.pluginRoot,
        workspaceRoot,
      });
    }
  }
  return merged;
}
