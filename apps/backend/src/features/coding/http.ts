import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { ConflictError, NotFoundError } from "../../infra/domain-errors.js";
import type { TerminalCommand, TerminalInfo, TerminalRegistry } from "./terminal-registry.js";

/** Coding-page surface (Herd-style terminals for project worktrees).
 *
 *  REST endpoints ride the normal auth chain (BFF → x-auth-token). The
 *  terminal byte stream cannot: browser WebSocket cannot set headers and
 *  must bypass the Next BFF (route handlers cannot proxy WS). So WS auth
 *  is a one-time ticket minted THROUGH the authenticated REST chain and
 *  consumed at upgrade — minting is as strong as the REST chain, and a
 *  leaked ticket buys one connection inside 60 seconds, nothing else. */

export interface CodingTarget {
  cwd: string;
  shell: TerminalCommand;
  /** Shell-ready command line that starts the oma TUI inside the pane.
   *  Herdr parity: the pane opens as a plain shell; launching the agent
   *  is an explicit user action (the button types this line). */
  omaLaunch: string;
}

export interface CodingRoutesDeps {
  registry: TerminalRegistry;
  resolveTarget: (projectId: string, agentId: string) => Promise<CodingTarget>;
  /** ws://host:port the browser connects terminals to (direct, plan A). */
  wsBase: string;
}

const TICKET_TTL_MS = 60_000;

interface WsIn {
  t?: string;
  d?: string;
  cols?: number;
  rows?: number;
}

export function codingRoutes(deps: CodingRoutesDeps) {
  const { registry, resolveTarget, wsBase } = deps;
  const tickets = new Map<string, number>();
  const unsubscribes = new WeakMap<object, () => void>();

  function mintTicket(): string {
    const ticket = randomBytes(32).toString("hex");
    tickets.set(ticket, Date.now() + TICKET_TTL_MS);
    for (const [k, exp] of tickets) if (exp < Date.now()) tickets.delete(k);
    return ticket;
  }

  function consumeTicket(ticket: string): boolean {
    const exp = tickets.get(ticket);
    tickets.delete(ticket);
    return exp !== undefined && exp >= Date.now();
  }

  const mapDomainError = (err: unknown): Response | null =>
    err instanceof NotFoundError
      ? Response.json({ error: err.message }, { status: 404 })
      : err instanceof ConflictError
        ? Response.json({ error: err.message }, { status: 409 })
        : null;

  return new Elysia()
    .get("/api/coding/terminals", () => ({ terminals: registry.list() }))
    .post(
      "/api/coding/terminals",
      async ({ body, set }) => {
        try {
          const target = await resolveTarget(body.projectId, body.agentId);
          const terminal = registry.spawn({
            projectId: body.projectId,
            agentId: body.agentId,
            cwd: target.cwd,
            title: body.title ?? "bash",
            command: target.shell,
            cols: body.cols,
            rows: body.rows,
          });
          set.status = 201;
          return { terminal, omaLaunch: target.omaLaunch };
        } catch (err) {
          const mapped = mapDomainError(err);
          if (mapped) return mapped;
          throw err;
        }
      },
      {
        body: t.Object({
          projectId: t.String({ minLength: 1 }),
          agentId: t.String({ minLength: 1 }),
          title: t.Optional(t.String({ minLength: 1 })),
          cols: t.Optional(t.Integer({ minimum: 2, maximum: 500 })),
          rows: t.Optional(t.Integer({ minimum: 2, maximum: 300 })),
        }),
      },
    )
    .post("/api/coding/terminals/:id/launch-oma", async ({ params: { id } }) => {
      const info = registry.get(id);
      if (!info) return Response.json({ error: "terminal not found" }, { status: 404 });
      try {
        const target = await resolveTarget(info.projectId, info.agentId);
        registry.write(id, `${target.omaLaunch}\n`);
        return { ok: true };
      } catch (err) {
        const mapped = mapDomainError(err);
        if (mapped) return mapped;
        throw err;
      }
    })
    .post("/api/coding/terminals/:id/respawn", ({ params: { id } }) => {
      const terminal = registry.respawn(id);
      if (!terminal) return Response.json({ error: "terminal not found" }, { status: 404 });
      return { terminal };
    })
    .delete("/api/coding/terminals/:id", ({ params: { id } }) => {
      if (!registry.close(id)) {
        return Response.json({ error: "terminal not found" }, { status: 404 });
      }
      return Response.json({ ok: true });
    })
    .post("/api/coding/ws-ticket", () => ({ ticket: mintTicket(), wsBase }))
    .ws("/ws/coding/:id", {
      open(ws) {
        const id = ws.data.params.id;
        const ticket = ws.data.query.ticket;
        if (!ticket || !consumeTicket(ticket)) {
          ws.close(4001, "invalid ticket");
          return;
        }
        const attached = registry.attach(id, {
          onData: (d) => ws.send(JSON.stringify({ t: "o", d })),
          onStatus: (info: TerminalInfo) =>
            ws.send(JSON.stringify({ t: "s", status: info.status, exitCode: info.exitCode })),
        });
        if (!attached) {
          ws.close(4404, "terminal not found");
          return;
        }
        unsubscribes.set(ws, attached.unsubscribe);
        // Replay BEFORE any live output could interleave: attach() handed us
        // the snapshot atomically with the subscription.
        ws.send(JSON.stringify({ t: "o", d: attached.replay }));
        const info = registry.get(id);
        if (info) ws.send(JSON.stringify({ t: "s", status: info.status, exitCode: info.exitCode }));
      },
      // Elysia pre-parses JSON frames: `message` is already an object.
      // Strings (non-JSON or foreign clients) still parse manually.
      message(ws, raw) {
        let msg: WsIn;
        if (typeof raw === "string") {
          try {
            msg = JSON.parse(raw) as WsIn;
          } catch {
            return;
          }
        } else if (raw && typeof raw === "object") {
          msg = raw as WsIn;
        } else {
          return;
        }
        const id = ws.data.params.id;
        if (msg.t === "i" && typeof msg.d === "string") {
          registry.write(id, msg.d);
        } else if (msg.t === "r" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          registry.resize(id, msg.cols as number, msg.rows as number);
        }
      },
      close(ws) {
        // detach ONLY — the PTY keeps running (the whole point).
        unsubscribes.get(ws)?.();
      },
    });
}
