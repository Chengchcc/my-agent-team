/** The AHP face's HTTP/WS mount point.
 *
 *  The protocol machinery lives in `protocol.ts`; this file does three things: mint tickets
 *  (a browser cannot set headers on a WebSocket handshake, so the upgrade carries the auth),
 *  feed frames into a connection, and clean up on close. The ticket registry is shared
 *  with the coding terminal stream (`infra/ws-ticket`). */
import { Elysia } from "elysia";
import { createWsTicketRegistry } from "../../infra/ws-ticket.js";
import { type AhpCommandPort, type AhpStateSource, createAhpServer } from "./protocol.js";

export interface AhpHostOptions {
  readonly source: AhpStateSource;
  readonly commands: AhpCommandPort;
  /** A ws address a browser can reach (a wildcard bind has to become the loopback). */
  readonly wsBase: string;
  readonly replayBufferSize?: number;
}

export function createAhpHost(opts: AhpHostOptions) {
  const tickets = createWsTicketRegistry();
  const server = createAhpServer({
    source: opts.source,
    commands: opts.commands,
    ...(opts.replayBufferSize !== undefined ? { replayBufferSize: opts.replayBufferSize } : {}),
  });
  /** The connection lives on the socket's own data. Elysia does not promise that the `ws`
   *  wrapper it hands to each callback is the same object - keying a WeakMap on `ws` gave an
   *  undefined lookup in `message` for a connection stored in `open` (measured) - while
   *  `ws.data` is the per-socket slot kept for exactly this. */
  type AhpSocketData = { ahp?: { handle(frame: string): void; close(): void } };
  const dataOf = (ws: { data: unknown }): AhpSocketData => ws.data as AhpSocketData;

  const routes = new Elysia()
    .post("/api/ahp/ws-ticket", () => ({ ticket: tickets.mint(), wsBase: opts.wsBase }))
    .ws("/ws/ahp", {
      open(ws) {
        const ticket = ws.data.query?.ticket;
        if (typeof ticket !== "string" || !tickets.consume(ticket)) {
          ws.close(4001, "invalid ticket");
          return;
        }
        dataOf(ws).ahp = server.createConnection((frame) => ws.send(frame));
      },
      message(ws, raw) {
        const connection = dataOf(ws).ahp;
        if (!connection) return;
        // Elysia pre-parses JSON frames and an AHP frame is JSON: re-serializing is enough.
        connection.handle(typeof raw === "string" ? raw : JSON.stringify(raw));
      },
      close(ws) {
        const connection = dataOf(ws).ahp;
        connection?.close();
        dataOf(ws).ahp = undefined;
      },
    });

  return { server, routes };
}

/** The host's concrete type (Elysia's generics reject widening to `Elysia`). */
export type AhpHost = ReturnType<typeof createAhpHost>;
