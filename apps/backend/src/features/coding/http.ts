import { Elysia, t } from "elysia";
import { ConflictError, NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import type { EntityLabelResolver } from "../../infra/entity-labels.js";
import { createWsTicketRegistry } from "../../infra/ws-ticket.js";
import { readAgentStatusFor } from "./agent-status.js";
import type { TaskWorktree } from "./task-worktrees.js";
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
  /** The pane shape for oma-kind (re)spawns: run oma --continue, then
   *  drop into a shell when it exits. Used by the restart button and by
   *  boot restore — injection is for live shells only (startup race). */
  omaPane: TerminalCommand;
}

export interface CodingRoutesDeps {
  registry: TerminalRegistry;
  /** `projectId` null/absent = the agent's OWN workspace (no worktree): the
   *  directory a room's worker runs in, so a conversation links right to it
   *  (ADR 0073). */
  resolveTarget: (
    projectId: string | null | undefined,
    agentId: string,
    worktreePath?: string,
  ) => Promise<CodingTarget>;
  /** ws://host:port the browser connects terminals to (direct, plan A). */
  wsBase: string;
  /** Task worktrees (the task axis): list existing, create a new one. */
  listTaskWorktrees: (projectId: string) => Promise<readonly TaskWorktree[]>;
  createTaskWorktree: (
    projectId: string,
    agentId: string,
    slug: string,
  ) => Promise<{ path: string }>;
  removeTaskWorktree: (
    projectId: string,
    agentId: string,
    slug: string,
    force: boolean,
  ) => Promise<{ path: string }>;
  /** ADR 0082 D5: optional batch label resolver for terminal DTOs. */
  labelResolver?: EntityLabelResolver;
  /** ADR 0082 D3: resolve current requirement for a conversation when spawning a terminal. */
  requirementOfConversation?: (conversationId: string) => string | null;
}

interface WsIn {
  t?: string;
  d?: string;
  cols?: number;

  rows?: number;
}

export function codingRoutes(deps: CodingRoutesDeps) {
  const {
    registry,
    resolveTarget,
    wsBase,
    listTaskWorktrees,
    createTaskWorktree,
    removeTaskWorktree,
  } = deps;
  const unsubscribes = new WeakMap<object, () => void>();
  // 票据逻辑已抽到 infra/ws-ticket.ts，与 AHP 宿主共用一套（upgrade 时的鉴权方式）。
  const tickets = createWsTicketRegistry();

  const mapDomainError = (err: unknown): Response | null =>
    err instanceof NotFoundError
      ? Response.json({ error: err.message }, { status: 404 })
      : err instanceof ConflictError
        ? Response.json({ error: err.message }, { status: 409 })
        : err instanceof ValidationError
          ? Response.json({ error: err.message }, { status: 422 })
          : null;

  return new Elysia()
    .get(
      "/api/coding/terminals",
      ({ query }) => {
        const list = registry.list().filter((item) => {
          if (query.conversationId && item.conversationId !== query.conversationId) return false;
          if (query.requirementId && item.requirementId !== query.requirementId) return false;
          if (query.projectId && item.projectId !== query.projectId) return false;
          if (query.agentId && item.agentId !== query.agentId) return false;
          return true;
        });
        const maps = deps.labelResolver?.resolveBatch({
          agentIds: list.map((item) => item.agentId),
          projectIds: list.map((item) => item.projectId),
          conversationIds: list.map((item) => item.conversationId),
          requirementIds: list.map((item) => item.requirementId),
        });
        return {
          terminals: list.map((item) => {
            const labels = deps.labelResolver?.labelsFor(
              {
                agentId: item.agentId,
                projectId: item.projectId,
                conversationId: item.conversationId,
                requirementId: item.requirementId,
              },
              maps,
            );
            return {
              ...item,
              ...(labels ? { labels } : {}),
              // Structured pane state (P2): only a live oma pane carries one.
              ...(item.kind === "oma" && item.status === "running"
                ? { agentState: readAgentStatusFor(item.cwd)?.state }
                : {}),
            };
          }),
        };
      },
      {
        query: t.Object({
          conversationId: t.Optional(t.String()),
          requirementId: t.Optional(t.String()),
          projectId: t.Optional(t.String()),
          agentId: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/api/coding/terminals",
      async ({ body, set }) => {
        try {
          const target = await resolveTarget(
            body.projectId ?? null,
            body.agentId,
            body.worktreePath,
          );
          const inferredRequirementId =
            body.requirementId ??
            (body.conversationId
              ? (deps.requirementOfConversation?.(body.conversationId) ?? null)
              : null);
          const terminal = registry.spawn({
            projectId: body.projectId ?? null,
            agentId: body.agentId,
            workspaceId: body.workspaceId ?? null,
            conversationId: body.conversationId ?? null,
            requirementId: inferredRequirementId,
            cwd: target.cwd,
            title: body.title ?? "bash",
            command: target.shell,
            cols: body.cols,
            rows: body.rows,
          });
          const labels = deps.labelResolver?.labelsFor({
            agentId: terminal.agentId,
            projectId: terminal.projectId,
            conversationId: terminal.conversationId,
            requirementId: terminal.requirementId,
          });
          set.status = 201;
          return {
            terminal: { ...terminal, ...(labels ? { labels } : {}) },
            omaLaunch: target.omaLaunch,
          };
        } catch (err) {
          const mapped = mapDomainError(err);
          if (mapped) return mapped;
          throw err;
        }
      },
      {
        body: t.Object({
          // Absent = a terminal in the agent's own workspace (ADR 0073).
          projectId: t.Optional(t.String({ minLength: 1 })),
          agentId: t.String({ minLength: 1 }),
          workspaceId: t.Optional(t.String({ minLength: 1 })),
          conversationId: t.Optional(t.String({ minLength: 1 })),
          requirementId: t.Optional(t.String({ minLength: 1 })),
          title: t.Optional(t.String({ minLength: 1 })),
          worktreePath: t.Optional(t.String({ minLength: 1 })),
          cols: t.Optional(t.Integer({ minimum: 2, maximum: 500 })),
          rows: t.Optional(t.Integer({ minimum: 2, maximum: 300 })),
        }),
      },
    )
    .get(
      "/api/coding/worktrees",
      ({ query: { projectId } }) => listTaskWorktrees(projectId).then((w) => ({ worktrees: w })),
      { query: t.Object({ projectId: t.String({ minLength: 1 }) }) },
    )
    .post(
      "/api/coding/worktrees",
      async ({ body, set }) => {
        try {
          const created = await createTaskWorktree(body.projectId, body.agentId, body.slug);
          set.status = 201;
          return created;
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
          slug: t.String({ minLength: 1, maxLength: 40 }),
        }),
      },
    )
    .post(
      "/api/coding/worktrees/remove",
      async ({ body, set }) => {
        try {
          const removed = await removeTaskWorktree(
            body.projectId,
            body.agentId,
            body.slug,
            body.force ?? false,
          );
          set.status = 200;
          return removed;
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
          slug: t.String({ minLength: 1, maxLength: 40 }),
          // Discards uncommitted changes; the UI warns before setting it.
          force: t.Optional(t.Boolean()),
        }),
      },
    )
    .post("/api/coding/terminals/:id/launch-oma", async ({ params: { id } }) => {
      const info = registry.get(id);
      if (!info) return Response.json({ error: "terminal not found" }, { status: 404 });
      if (info.status !== "running") {
        return Response.json(
          { error: "terminal process has exited — restart the pane first" },
          { status: 409 },
        );
      }
      try {
        const target = await resolveTarget(info.projectId, info.agentId);
        registry.write(id, `${target.omaLaunch}\n`);
        // The pane is now an oma pane: restart and boot-restore use the
        // --continue form instead of a bare shell.
        registry.setKind(id, "oma", "oma");
        return { ok: true };
      } catch (err) {
        const mapped = mapDomainError(err);
        if (mapped) return mapped;
        throw err;
      }
    })
    .post("/api/coding/terminals/:id/respawn", async ({ params: { id } }) => {
      const info = registry.get(id);
      if (!info) return Response.json({ error: "terminal not found" }, { status: 404 });
      if (info.kind === "oma") {
        try {
          const target = await resolveTarget(info.projectId, info.agentId);
          const terminal = registry.respawn(id, target.omaPane);
          if (!terminal) return Response.json({ error: "terminal not found" }, { status: 404 });
          return { terminal };
        } catch (err) {
          const mapped = mapDomainError(err);
          if (mapped) return mapped;
          throw err;
        }
      }
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
    .post("/api/coding/ws-ticket", () => ({ ticket: tickets.mint(), wsBase }))
    .ws("/ws/coding/:id", {
      open(ws) {
        const id = ws.data.params.id;
        const ticket = ws.data.query.ticket;
        if (!ticket || !tickets.consume(ticket)) {
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
