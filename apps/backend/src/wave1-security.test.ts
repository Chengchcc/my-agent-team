import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { BackendConfig } from "./config.js";
import {
  callAgentConfigTool,
  createAgentConfigMcpServer,
  createCreateBudget,
} from "./features/agent/agent-config-mcp.js";
import type { AgentRow } from "./features/agent/domain.js";
import { agentRoutes } from "./features/agent/http.js";
import type { AgentPort } from "./features/agent/ports.js";
import { createAgentService } from "./features/agent/service.js";
import { extractMcpSecrets, writeMcpConfig } from "./features/agent/workspace-bridge.js";
import { sqliteAgentContextAdapter } from "./features/agent-context/adapter-sqlite.js";
import type { IdGenerator, LedgerMessageResolver } from "./features/agent-context/ports.js";
import { createAgentContextService } from "./features/agent-context/service.js";
import { sqliteAgentRunAdapter } from "./features/agent-run/adapter-sqlite.js";
import { createAgentRunService } from "./features/agent-run/service.js";
import { sqliteConversationAdapter } from "./features/conversation/adapter-sqlite.js";
import { SystemdLarkBotRegistry } from "./features/lark-bot/systemd-registry.js";
import { createRunTokenRegistry } from "./features/product-tools/run-token-registry.js";
import { ProjectPushRefused, pushProjectWorktree } from "./features/project/push.js";
import { createProjectService } from "./features/project/service.js";
import { createProviderService } from "./features/provider/service.js";
import { sqliteSettingsAdapter } from "./features/settings/adapter-sqlite.js";
import { settingsRoutes } from "./features/settings/http.js";
import { createSettingsService } from "./features/settings/service.js";
import { createFsWikiStore } from "./features/wiki/adapter-fs.js";
import { createWikiService } from "./features/wiki/service.js";
import { createWorkflowMcpServer } from "./features/workflow/mcp.js";
import { hostAllowed, startAllowlistProxy } from "./infra/allowlist-proxy.js";
import { checkAuthToken, safeTokenEqual } from "./infra/auth.js";
import { resolveOmaCommand } from "./infra/oma-command.js";
import { openDb } from "./infra/sqlite/db.js";
import { purgeWorkspace } from "./infra/workspace.js";

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Wave 1 security regressions", () => {
  test("P0-1: queued input promoted by acquireNextRun preserves frozen toolPolicy (including disabledTools)", async () => {
    const db = openDb(":memory:");
    try {
      const conv = sqliteConversationAdapter(db);
      const ctxPort = sqliteAgentContextAdapter(db);
      const idGen: IdGenerator = {
        ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26),
      };
      const ledgerResolver: LedgerMessageResolver = {
        async resolveMessage(conversationId, seq) {
          const entry = conv.getLedgerEntry(conversationId, seq);
          return entry ? (entry.content as never) : null;
        },
      };
      const ctxService = createAgentContextService({ port: ctxPort, idGen, ledgerResolver });
      const runPort = sqliteAgentRunAdapter(db, { contextPort: ctxPort, ledgerResolver, idGen });
      const policy = {
        deny: ["/etc/"],
        allow: ["/tmp/ws/"],
        denyCommands: ["rm -rf /"],
        disabledTools: ["bash", "write", "edit"],
      };
      const runSvc = createAgentRunService({
        port: runPort,
        contextService: ctxService,
        idGen,
        ledgerResolver,
        resolveRunConfig: async () => ({ toolPolicy: policy }),
      });

      conv.createConversation({ conversationId: "c1", agentId: "pa", createdAt: Date.now() });
      const r1 = await runSvc.enqueueAndAcquire({
        conversationId: "c1",
        agentId: "pa",
        backendKind: "acp",
        mode: "normal",
        message: { role: "user", text: "first" },
        defaultModel: { backendKind: "acp", modelId: "acp/oma" },
        configRevision: 1,
        idempotencyKey: "k1",
      });
      expect(r1.acquired).toBe(true);
      expect(r1.run?.toolPolicy).toEqual(policy);

      // Enqueue second message while run 1 is active -> queued in branch_input_queue
      const r2 = await runSvc.enqueueAndAcquire({
        conversationId: "c1",
        agentId: "pa",
        backendKind: "acp",
        mode: "normal",
        message: { role: "user", text: "second" },
        defaultModel: { backendKind: "acp", modelId: "acp/oma" },
        configRevision: 1,
        idempotencyKey: "k2",
      });
      expect(r2.queued).toBe(true);

      // Finalize run 1 and promote queued input via acquireNextRun
      await runPort.finalizeRun(r1.run!.runId, { status: "completed" });
      const promoted = await runPort.acquireNextRun(r1.run!.branchId);
      expect(promoted).not.toBeNull();
      expect(promoted?.toolPolicy).toEqual(policy);
    } finally {
      db.close();
    }
  });

  test("P0-2: wiki store and wiki addSource block path traversal and symlinks", () => {
    const root = makeTmp("wiki-sec-");
    const outside = makeTmp("wiki-out-");
    writeFileSync(join(outside, "secret.md"), "TOP_SECRET", "utf8");
    const store = createFsWikiStore(root);
    const wiki = createWikiService({ store });

    expect(() => store.write("../escaped.md", "evil", { author: "a", summary: "s" })).toThrow(
      /escapes/,
    );
    expect(() => store.read("../../etc/passwd")).toThrow(/escapes/);
    expect(() =>
      wiki.addSource({
        agentId: "a",
        kind: "conversation",
        conversationId: "../../outside/poison",
      }),
    ).toThrow(/invalid conversationId/);

    symlinkSync(join(outside, "secret.md"), join(root, "concepts", "leak.md"));
    expect(() => store.read("concepts/leak.md")).toThrow(/symlink/);
  });

  test("P0-3: checkAuthToken and safeTokenEqual handle multi-byte UTF-8 without throwing RangeError", () => {
    // Same UTF-16 length (4), different UTF-8 byte length (5 vs 4)
    expect(checkAuthToken("éabc", "abcd")).toBe(false);
    expect(safeTokenEqual("éabc", "abcd")).toBe(false);
    expect(checkAuthToken("secret-token", "secret-token")).toBe(true);
    expect(checkAuthToken("", "")).toBe(false);
  });

  test("P0-4 & P1-3: workspace entries/file block symlinks & .mcp.json; agent create preserves policy; purgeWorkspace blocks symlinks", async () => {
    const allowedRoot = makeTmp("agent-allowed-");
    const outside = makeTmp("agent-outside-");
    writeFileSync(join(outside, "host-secret.txt"), "HOST_SECRET", "utf8");
    const wsDir = join(allowedRoot, "a1");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, ".mcp.json"), '{"mcpServers":{}}', "utf8");
    symlinkSync(outside, join(wsDir, "escape-link"));

    const rows = new Map<string, AgentRow>();
    const port: AgentPort = {
      async create(input) {
        const row: AgentRow = {
          id: input.id,
          workspacePath: input.workspacePath,
          config: input.config,
          createdAt: input.now,
          updatedAt: input.now,
          archivedAt: null,
        };
        rows.set(input.id, row);
        return row;
      },
      async findById(id) {
        return rows.get(id) ?? null;
      },
      async list() {
        return [...rows.values()];
      },
      async update() {
        return null;
      },
      async archive() {
        return null;
      },
      async hardDelete() {
        return { deletedAgent: false };
      },
    };
    const svc = createAgentService({
      port,
      idGen: () => "a1",
      workspaceRoot: allowedRoot,
      allowedWorkspaceRoots: [allowedRoot],
      materializeWorkspace: async () => wsDir,
      purgeWorkspace: async () => {},
      assertNoActiveRun: () => {},
    });

    // P1-3: create() persists denyWritePaths / allowWritePaths / denyCommands
    const created = await svc.create({
      name: "guarded",
      harness: "oma",
      denyWritePaths: ["/etc/"],
      allowWritePaths: ["/tmp/out/"],
      denyCommands: ["rm -rf"],
    });
    expect(created.config.runtime_config.deny_write_paths).toEqual(["/etc/"]);
    expect(created.config.runtime_config.allow_write_paths).toEqual(["/tmp/out/"]);
    expect(created.config.runtime_config.deny_commands).toEqual(["rm -rf"]);

    // P0-4: workspacePath symlink override rejected
    const symlinkOverride = join(allowedRoot, "sym-override");
    symlinkSync(outside, symlinkOverride);
    await expect(
      svc.create({ name: "bad", harness: "oma", workspacePath: symlinkOverride }),
    ).rejects.toThrow();

    // P0-4: /workspace/entries blocks escaping symlink & returns 404 for missing; /workspace/file blocks .mcp.json
    const app = new Elysia().use(
      agentRoutes(svc, { listForAgent: async () => [], setAgentPacks: async () => {} }),
    );
    const escResp = await app.handle(
      new Request("http://localhost/api/agents/a1/workspace/entries?path=escape-link"),
    );
    expect(escResp.status).toBe(403);
    const missingResp = await app.handle(
      new Request("http://localhost/api/agents/a1/workspace/entries?path=does-not-exist"),
    );
    expect(missingResp.status).toBe(404);
    const mcpResp = await app.handle(
      new Request("http://localhost/api/agents/a1/workspace/file?path=.mcp.json"),
    );
    expect(mcpResp.status).toBe(403);

    // P0-4: purgeWorkspace rejects symlink pointing outside root
    await expect(
      purgeWorkspace({ workspaceRoot: allowedRoot, workspacePath: symlinkOverride }),
    ).rejects.toThrow(/symlink|traversal/);
  });

  test("P1-2: settings route blocks providerEnv; providerService filters customEnv; resolveOmaCommand pins invariants", async () => {
    const db = openDb(":memory:");
    try {
      const settingsSvc = createSettingsService({
        port: sqliteSettingsAdapter(db),
        config: {
          dataDir: "/tmp",
          workspaceRoot: "/tmp",
          builtinSkillsDir: "/tmp",
        } as BackendConfig,
        secretKey: Buffer.alloc(32, 7),
      });
      const app = new Elysia().use(settingsRoutes(settingsSvc));
      const putResp = await app.handle(
        new Request("http://localhost/api/settings/providerEnv", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: { NODE_OPTIONS: "--evil" } }),
        }),
      );
      expect(putResp.status).toBe(400);

      // Even if DB contains a polluted key, customEnv() drops non-*_API_KEY keys
      settingsSvc.set("providerEnv", {
        GOOD_API_KEY: "sk-123",
        NODE_OPTIONS: "--inspect",
        OMA_WORKSPACE_CATALOG: "1",
      });
      const providerSvc = createProviderService(settingsSvc);
      const env = providerSvc.getProviderEnv();
      expect(env.GOOD_API_KEY).toBe("sk-123");
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.OMA_WORKSPACE_CATALOG).toBeUndefined();

      // resolveOmaCommand pins security invariants after opts.env
      const cmd = resolveOmaCommand({ omaBin: "/usr/bin/oma" } as BackendConfig, {
        env: { OMA_WORKSPACE_CATALOG: "1", OMA_TITLE_ENABLED: "1" },
      });
      expect(cmd.env?.OMA_WORKSPACE_CATALOG).toBe("0");
      expect(cmd.env?.OMA_TITLE_ENABLED).toBe("0");
    } finally {
      db.close();
    }
  });

  test("P1-4: SystemdLarkBotRegistry rejects newline injection in botDisplayName", async () => {
    const dataDir = makeTmp("systemd-sec-");
    const calls: string[][] = [];
    const reg = new SystemdLarkBotRegistry({
      dataDir,
      backendUrl: "http://127.0.0.1:3000",
      backendAuthToken: "tok",
      entryPath: "/repo/apps/lark-bot/src/main.ts",
      run: async (args) => {
        calls.push([...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await reg.ensureLarkBot("a1", "Bot\nLARK_BOT_BUN=/tmp/evil");
    expect(reg.statusOf("a1")).toBe("error");
    expect(calls.length).toBe(0);
  });

  test("P1-5 & P1-6: MCP auth/host checks, agent_write blocks yolo/policy, extractMcpSecrets keeps .mcp.json secret-free", async () => {
    const registry = createRunTokenRegistry();
    const wfDir = makeTmp("wf-mcp-sec-");
    const wfMcp = await createWorkflowMcpServer({ workflowDir: wfDir, tokenRegistry: registry });
    const acMcp = await createAgentConfigMcpServer({
      readConfig: async () => ({}),
      agentExists: async () => true,
      createAgent: async () => ({ id: "x" }),
      tokenRegistry: registry,
    });
    try {
      // Missing bearer -> 401
      const r1 = await fetch(wfMcp.url);
      expect(r1.status).toBe(401);
      const r2 = await fetch(acMcp.url);
      expect(r2.status).toBe(401);
      // Bad Host -> 403
      const r3 = await fetch(wfMcp.url, { headers: { host: "evil.example.com" } });
      expect(r3.status).toBe(403);
    } finally {
      await wfMcp.close();
      await acMcp.close();
    }

    // agent_write rejects yolo and security policy tampering
    const deps = {
      readConfig: async () => ({}),
      agentExists: async () => true,
      createAgent: async () => ({ id: "x" }),
      reserveCreate: createCreateBudget({ max: 1, windowMs: 60_000 }),
    };
    await expect(
      callAgentConfigTool(deps, "agent_write", {
        agentId: "a1",
        config: { runtime_config: { permission_mode: "yolo" } },
      }),
    ).rejects.toThrow(/yolo/);
    await expect(
      callAgentConfigTool(deps, "agent_write", {
        agentId: "a1",
        config: { runtime_config: { deny_write_paths: [] } },
      }),
    ).rejects.toThrow(/security policy/);
    // agent_create enforces reserveCreate budget
    await callAgentConfigTool(deps, "agent_create", { name: "One", harness: "oma" });
    await expect(
      callAgentConfigTool(deps, "agent_create", { name: "Two", harness: "oma" }),
    ).rejects.toThrow(/budget/);

    // P1-6: extractMcpSecrets moves user secrets out of .mcp.json into spawn env
    const ws = makeTmp("mcp-bridge-sec-");
    const extracted = extractMcpSecrets([
      {
        name: "github",
        transport: "sse",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer ghp_supersecret" },
        env: { GITHUB_TOKEN: "ghp_supersecret" },
      },
    ]);
    writeMcpConfig(ws, extracted.servers);
    const onDisk = readFileSync(join(ws, ".mcp.json"), "utf8");
    expect(onDisk).not.toContain("ghp_supersecret");
    expect(extracted.expandableVars.length).toBe(2);
    expect(Object.values(extracted.env)).toContain("ghp_supersecret");
  });

  test("P2-8 & P2-9: project defaultBranch blocks '..' and push refuses non-allowlisted https host", () => {
    const projectSvc = createProjectService({
      port: {
        createProject: (row) => ({ ...row, updatedAt: row.createdAt }),
        getProject: () => null,
        listProjects: () => [],
        updateProject: () => null,
        deleteProject: () => false,
      },
      idGen: () => "p1",
    });
    expect(() =>
      projectSvc.createProject({
        name: "p",
        repoUrl: "https://github.com/o/r.git",
        defaultBranch: "a..b",
      }),
    ).toThrow();

    // Non-allowlisted host refused for PROJECT_PUSH_TOKEN
    const repo = makeTmp("push-host-");
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.email", "t@l"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "f.txt"), "a\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: repo });
    writeFileSync(join(repo, "f.txt"), "b\n");
    expect(() =>
      pushProjectWorktree({
        worktree: repo,
        repoUrl: "https://evil.attacker.invalid/o/r.git",
        runId: "r1",
        message: "m",
        token: "ghp_secret",
      }),
    ).toThrow(ProjectPushRefused);
  });

  test("allowlist-proxy blocks metadata hosts even under '*' and rejects invalid CONNECT port", async () => {
    expect(hostAllowed("169.254.169.254", ["*"])).toBe(false);
    expect(hostAllowed("metadata.google.internal", ["*"])).toBe(false);
    expect(hostAllowed("github.com", ["*"])).toBe(true);

    const proxy = await startAllowlistProxy(["*"]);
    try {
      const url = new URL(proxy.url);
      const conn = await Bun.connect({
        hostname: url.hostname,
        port: Number(url.port),
        socket: {
          data(_socket, data) {
            received += data.toString();
          },
          open(socket) {
            socket.write("CONNECT github.com:99999 HTTP/1.1\r\nHost: github.com:99999\r\n\r\n");
          },
          close() {
            resolveClosed();
          },
          error() {
            resolveClosed();
          },
        },
      });
      let received = "";
      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => {
        resolveClosed = r;
      });
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
      conn.end();
      expect(received).toContain("400 Bad Request");
    } finally {
      await proxy.close();
    }
  });
});
