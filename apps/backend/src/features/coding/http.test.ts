import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { NotFoundError } from "../../infra/domain-errors.js";
import { codingRoutes } from "./http.js";
import { createTerminalRegistry } from "./terminal-registry.js";

// Real Elysia server on an ephemeral port + real browser-style WebSocket:
// the ticket mint → WS attach → replay → input → output loop, end to end.
const dir = mkdtempSync(join(tmpdir(), "coding-http-"));
const wsDir = join(dir, "ws-req-1");
mkdirSync(wsDir, { recursive: true });
const seenWorkspaceIds: Array<string | undefined> = [];
const registry = createTerminalRegistry();
const app = new Elysia().use(
  codingRoutes({
    registry,
    resolveTarget: async (projectId, _agentId, workspaceId) => {
      if (projectId === "ghost") throw new NotFoundError("project", projectId);
      seenWorkspaceIds.push(workspaceId);
      return {
        cwd: workspaceId === "ws-1" ? wsDir : dir,
        shell: { executable: "/bin/bash", args: ["-c", "echo boot-marker; exec bash"] },
        omaLaunch: "echo oma-launch-line",
        omaPane: { executable: "/bin/bash", args: ["-c", "echo oma-pane-boot; exec bash"] },
        harnessLaunch: {
          oma: "echo oma-launch-line",
          claude: "echo claude-launch-line && echo 'Do you want to proceed? (y/n)'",
          pi: "echo pi-launch-line",
          omp: "echo omp-launch-line",
        },
        harnessPane: {
          oma: { executable: "/bin/bash", args: ["-c", "echo oma-pane-boot; exec bash"] },
          claude: { executable: "/bin/bash", args: ["-c", "echo claude-pane-boot; exec bash"] },
        },
        defaultHarness: "claude",
      };
    },
    listWorkspaces: async () => [
      {
        workspaceId: "ws-1",
        projectId: "p1",
        projectName: "Console",
        requirementId: "req-1",
        requirementTitle: "Herdr Coding Upgrade",
        conversationId: "conv-1",
        conversationTitle: "Coding discussion",
        defaultAgentId: "a1",
        defaultHarness: "claude",
        path: wsDir,
        branch: "req/req-1",
        ahead: 2,
        behind: 0,
        worktreeReady: true,
        state: "blocked",
        pendingActionCount: 1,
        activeRuns: [
          {
            runId: "run-1",
            agentId: "a1",
            agentName: "Coder",
            status: "waiting",
            conversationId: "conv-1",
            requirementId: "req-1",
            workspaceRoot: wsDir,
            pendingActionCount: 1,
            startedAt: 1_000,
          },
        ],
        terminalIds: [],
      },
    ],
    listActiveRuns: async () => [
      {
        runId: "run-1",
        agentId: "a1",
        agentName: "Coder",
        status: "waiting",
        conversationId: "conv-1",
        requirementId: "req-1",
        workspaceRoot: wsDir,
        pendingActionCount: 1,
        startedAt: 1_000,
      },
    ],
    wsBase: "ws://127.0.0.1:1",
  }),
);
app.listen(0);
const base = `http://127.0.0.1:${app.server!.port}`;

afterAll(() => {
  registry.closeAll();
  app.stop();
  rmSync(dir, { recursive: true, force: true });
});
function waitForMsg(messages: string[], needle: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (messages.some((m) => m.includes(needle))) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`ws message timeout waiting for ${needle}`));
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

function openWs(url: string): { ws: WebSocket; messages: string[]; opened: Promise<void> } {
  const ws = new WebSocket(url);
  // Collect from construction: the server replays the buffer the instant
  // the socket opens, before an open-callback listener would attach.
  const messages: string[] = [];
  ws.addEventListener("message", (ev) => messages.push(String(ev.data)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  return { ws, messages, opened };
}

const wsUrl = (terminalId: string, ticket: string) =>
  `ws://127.0.0.1:${app.server!.port}/ws/coding/${terminalId}?ticket=${ticket}`;

describe("coding routes", () => {
  test("ADR 0073: a terminal with NO project lands in the agent's workspace", async () => {
    // A room's worker runs in its own workspace, which has no project. The
    // resolver is called with null and the route stores projectId: null, so the
    // rail can group it as a workspace pane.
    const res = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ agentId: "a1" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { terminal?: { projectId?: string | null } };
    expect(body.terminal?.projectId).toBeNull();
  });

  test("unknown project maps to 404", async () => {
    const res = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ projectId: "ghost", agentId: "a" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("spawn → ticket → ws attach with replay → input round-trip → launch-oma writes the command", async () => {
    const spawnRes = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", agentId: "a1" }),
      headers: { "content-type": "application/json" },
    });
    expect(spawnRes.status).toBe(201);
    const body = (await spawnRes.json()) as {
      terminal: { terminalId: string; status: string };
      omaLaunch: string;
    };
    expect(body.terminal.status).toBe("running");
    expect(body.omaLaunch).toContain("oma-launch-line");

    const listed = (await (await fetch(`${base}/api/coding/terminals`)).json()) as {
      terminals: Array<{ terminalId: string }>;
    };
    expect(listed.terminals.some((t) => t.terminalId === body.terminal.terminalId)).toBe(true);

    const ticketRes = await fetch(`${base}/api/coding/ws-ticket`, { method: "POST" });
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const { ws, messages, opened } = openWs(wsUrl(body.terminal.terminalId, ticket));
    await opened;
    // attach replays the boot marker
    await waitForMsg(messages, "boot-marker");

    // input round-trips through the pty
    ws.send(JSON.stringify({ t: "i", d: "echo e2e-ok-42\n" }));
    await waitForMsg(messages, "e2e-ok-42");

    // launch-oma injects the resolved command line into the pane
    const launchRes = await fetch(
      `${base}/api/coding/terminals/${body.terminal.terminalId}/launch-oma`,
      { method: "POST" },
    );
    expect(launchRes.status).toBe(200);
    await waitForMsg(messages, "oma-launch-line");
    ws.close();
  }, 10_000);

  test("ticket is single-use; a second attach with it is refused", async () => {
    const spawnRes = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p2", agentId: "a2" }),
      headers: { "content-type": "application/json" },
    });
    const { terminal } = (await spawnRes.json()) as { terminal: { terminalId: string } };
    const { ticket } = (await (
      await fetch(`${base}/api/coding/ws-ticket`, { method: "POST" })
    ).json()) as { ticket: string };

    const first = openWs(wsUrl(terminal.terminalId, ticket));
    await first.opened;
    first.ws.close();

    const second = openWs(wsUrl(terminal.terminalId, ticket));
    const closed = new Promise<number>((resolve) =>
      second.ws.addEventListener("close", (ev) => resolve((ev as CloseEvent).code)),
    );
    expect(await closed).toBe(4001);
  }, 10_000);

  test("close (kill-pane) removes the terminal", async () => {
    const spawnRes = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p3", agentId: "a3" }),
      headers: { "content-type": "application/json" },
    });
    const { terminal } = (await spawnRes.json()) as { terminal: { terminalId: string } };
    const del = await fetch(`${base}/api/coding/terminals/${terminal.terminalId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const listed = (await (await fetch(`${base}/api/coding/terminals`)).json()) as {
      terminals: Array<{ terminalId: string }>;
    };
    expect(listed.terminals.some((t) => t.terminalId === terminal.terminalId)).toBe(false);
  });
});

describe("coding agent status enrichment (P2)", () => {
  test("a live oma terminal carries agentState; stale or shell panes don't", async () => {
    const spawnRes = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p9", agentId: "a9" }),
      headers: { "content-type": "application/json" },
    });
    const { terminal } = (await spawnRes.json()) as { terminal: { terminalId: string } };

    const listed = () =>
      fetch(`${base}/api/coding/terminals`).then(
        (r) =>
          r.json() as Promise<{
            terminals: Array<{ terminalId: string; agentState?: string }>;
          }>,
      );

    // No status file yet → no agentState on a shell-kind terminal.
    const before = (await listed()).terminals.find((t) => t.terminalId === terminal.terminalId);
    expect(before?.agentState).toBeUndefined();

    // Mark it an oma pane, write a fresh status file → agentState flows.
    await fetch(`${base}/api/coding/terminals/${terminal.terminalId}/launch-oma`, {
      method: "POST",
    });
    mkdirSync(join(dir, ".oma"), { recursive: true });
    writeFileSync(
      join(dir, ".oma", "agent-status.json"),
      JSON.stringify({ state: "blocked", sessionId: "s", ts: Date.now() }),
    );
    const enriched = (await listed()).terminals.find((t) => t.terminalId === terminal.terminalId);
    expect(enriched?.agentState).toBe("blocked");

    // A stale file (crashed writer) reports nothing rather than a lie.
    writeFileSync(
      join(dir, ".oma", "agent-status.json"),
      JSON.stringify({ state: "working", sessionId: "s", ts: Date.now() - 10 * 60_000 }),
    );
    const stale = (await listed()).terminals.find((t) => t.terminalId === terminal.terminalId);
    expect(stale?.agentState).toBeUndefined();
  });
  test("spawn with workspaceId lands in the resolved requirement workspace cwd", async () => {
    const res = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", agentId: "a1", workspaceId: "ws-1" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const { terminal } = (await res.json()) as { terminal: { terminalId: string } };
    const listed = (await (await fetch(`${base}/api/coding/terminals`)).json()) as {
      terminals: Array<{ terminalId: string; cwd: string }>;
    };
    const mine = listed.terminals.find((t) => t.terminalId === terminal.terminalId);
    expect(mine?.cwd).toBe(wsDir);
  });
});

describe("ADR 0083 Herdr dual-view workspaces, multi-harness launch, and semantic PTY state", () => {
  test("GET /api/coding/workspaces returns rolled-up workspace summaries", async () => {
    const res = await fetch(`${base}/api/coding/workspaces`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: Array<{
        workspaceId: string;
        requirementTitle: string | null;
        state: string;
        pendingActionCount: number;
      }>;
    };
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({
      workspaceId: "ws-1",
      requirementTitle: "Herdr Coding Upgrade",
      state: "blocked",
      pendingActionCount: 1,
    });
  });

  test("launch supports multi-harness (claude), propagates workspaceId, infers blocked PTY state, and attaches activeRuns", async () => {
    seenWorkspaceIds.length = 0;
    const spawnRes = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({
        projectId: "p1",
        agentId: "a1",
        workspaceId: "ws-1",
        requirementId: "req-1",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(spawnRes.status).toBe(201);
    const { terminal, defaultHarness } = (await spawnRes.json()) as {
      terminal: { terminalId: string };
      defaultHarness: string;
    };
    expect(defaultHarness).toBe("claude");

    // Launch with omitted harness uses defaultHarness ("claude") and preserves workspaceId.
    const launchRes = await fetch(`${base}/api/coding/terminals/${terminal.terminalId}/launch`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(launchRes.status).toBe(200);
    const launchBody = (await launchRes.json()) as { ok: boolean; harness: string };
    expect(launchBody).toEqual({ ok: true, harness: "claude" });
    expect(seenWorkspaceIds.at(-1)).toBe("ws-1");

    // Wait for the injected claude prompt line to hit the PTY buffer and infer "blocked".
    const deadline = Date.now() + 4_000;
    let matched:
      | {
          terminalId: string;
          kind: string;
          agentState?: string;
          activeRuns?: Array<{ runId: string; status: string }>;
        }
      | undefined;
    while (Date.now() < deadline) {
      const listed = (await (await fetch(`${base}/api/coding/terminals`)).json()) as {
        terminals: Array<{
          terminalId: string;
          kind: string;
          agentState?: string;
          activeRuns?: Array<{ runId: string; status: string }>;
        }>;
      };
      matched = listed.terminals.find((t) => t.terminalId === terminal.terminalId);
      if (matched?.agentState === "blocked") break;
      await Bun.sleep(50);
    }
    expect(matched?.kind).toBe("claude");
    expect(matched?.agentState).toBe("blocked");
    expect(matched?.activeRuns?.[0]?.runId).toBe("run-1");

    // Respawn also passes workspaceId and uses the claude harnessPane.
    const respawnRes = await fetch(`${base}/api/coding/terminals/${terminal.terminalId}/respawn`, {
      method: "POST",
    });
    expect(respawnRes.status).toBe(200);
    expect(seenWorkspaceIds.at(-1)).toBe("ws-1");
  }, 10_000);
});
