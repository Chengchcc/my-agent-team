import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { ConflictError, NotFoundError } from "../../infra/domain-errors.js";
import { codingRoutes } from "./http.js";
import { createTerminalRegistry } from "./terminal-registry.js";

// Real Elysia server on an ephemeral port + real browser-style WebSocket:
// the ticket mint → WS attach → replay → input → output loop, end to end.
const dir = mkdtempSync(join(tmpdir(), "coding-http-"));
const registry = createTerminalRegistry();
const app = new Elysia().use(
  codingRoutes({
    registry,
    resolveTarget: async (projectId, _agentId, worktreePath) => {
      if (projectId === "ghost") throw new NotFoundError("project", projectId);
      return {
        cwd: worktreePath ?? dir,
        shell: { executable: "/bin/bash", args: ["-c", "echo boot-marker; exec bash"] },
        omaLaunch: "echo oma-launch-line",
        omaPane: { executable: "/bin/bash", args: ["-c", "echo oma-pane-boot; exec bash"] },
      };
    },
    wsBase: "ws://127.0.0.1:1",
    listTaskWorktrees: async (projectId) =>
      projectId === "p1" ? [{ agentId: "a1", slug: "feat-x", path: join(dir, "p1.feat-x") }] : [],
    createTaskWorktree: async (_projectId: string, _agentId: string, slug: string) => ({
      path: join(dir, `p1.${slug}`),
    }),
    removeTaskWorktree: async (
      _projectId: string,
      _agentId: string,
      slug: string,
      force: boolean,
    ) => {
      if (slug === "busy") throw new ConflictError("close this worktree's terminals first");
      return { path: join(dir, `p1.${slug}${force ? "" : ""}`) };
    },
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
});

describe("coding task worktrees (the task axis)", () => {
  test("list and create endpoints round-trip", async () => {
    const listed = (await (await fetch(`${base}/api/coding/worktrees?projectId=p1`)).json()) as {
      worktrees: Array<{ slug: string }>;
    };
    expect(listed.worktrees).toHaveLength(1);
    expect(listed.worktrees[0]?.slug).toBe("feat-x");

    const created = await fetch(`${base}/api/coding/worktrees`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", agentId: "a1", slug: "task-two" }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { path: string };
    expect(body.path).toContain("p1.task-two");
  });

  test("remove endpoint maps outcomes and refusals", async () => {
    const ok = await fetch(`${base}/api/coding/worktrees/remove`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", agentId: "a1", slug: "task-two" }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    const removed = (await ok.json()) as { path: string };
    expect(removed.path).toContain("p1.task-two");

    const refused = await fetch(`${base}/api/coding/worktrees/remove`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", agentId: "a1", slug: "busy", force: true }),
      headers: { "content-type": "application/json" },
    });
    expect(refused.status).toBe(409);
  });

  test("spawn with a valid worktreePath lands in that cwd", async () => {
    const taskDir = join(dir, "p1.feat-x");
    mkdirSync(taskDir, { recursive: true });
    const res = await fetch(`${base}/api/coding/terminals`, {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", agentId: "a1", worktreePath: taskDir }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const { terminal } = (await res.json()) as { terminal: { terminalId: string } };
    const listed = (await (await fetch(`${base}/api/coding/terminals`)).json()) as {
      terminals: Array<{ terminalId: string; cwd: string }>;
    };
    const mine = listed.terminals.find((t) => t.terminalId === terminal.terminalId);
    expect(mine?.cwd).toBe(taskDir);
  });
});
