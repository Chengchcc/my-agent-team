import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { NotFoundError } from "../../infra/domain-errors.js";
import { codingRoutes } from "./http.js";
import { createTerminalRegistry } from "./terminal-registry.js";

// Real Elysia server on an ephemeral port + real browser-style WebSocket:
// the ticket mint → WS attach → replay → input → output loop, end to end.
const dir = mkdtempSync(join(tmpdir(), "coding-http-"));
const registry = createTerminalRegistry();
const app = new Elysia().use(
  codingRoutes({
    registry,
    resolveTarget: async (projectId) => {
      if (projectId === "ghost") throw new NotFoundError("project", projectId);
      return {
        cwd: dir,
        shell: { executable: "/bin/bash", args: ["-c", "echo boot-marker; exec bash"] },
        omaLaunch: "echo oma-launch-line",
      };
    },
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
