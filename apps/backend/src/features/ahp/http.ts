/** AHP 面的 HTTP/WS 挂载点。
 *
 *  协议机械在 `protocol.ts`，这里只做三件事：发票（浏览器 WebSocket 带不了自定义
 *  头，所以鉴权在 upgrade 时凭票完成）、把 WS 帧喂给连接、连接关闭时收尾。票制逻辑
 *  与 coding 终端流共用 `infra/ws-ticket`。 */
import { Elysia } from "elysia";
import { createWsTicketRegistry } from "../../infra/ws-ticket.js";
import { type AhpCommandPort, type AhpStateSource, createAhpServer } from "./protocol.js";

export interface AhpFaceOptions {
  readonly source: AhpStateSource;
  readonly commands: AhpCommandPort;
  /** 浏览器可达的 ws 地址（通配绑定要换成回环）。 */
  readonly wsBase: string;
  readonly replayBufferSize?: number;
}

export function createAhpFace(opts: AhpFaceOptions) {
  const tickets = createWsTicketRegistry();
  const server = createAhpServer({
    source: opts.source,
    commands: opts.commands,
    ...(opts.replayBufferSize !== undefined ? { replayBufferSize: opts.replayBufferSize } : {}),
  });
  const connections = new WeakMap<object, { handle(frame: string): void; close(): void }>();

  const routes = new Elysia()
    .post("/api/ahp/ws-ticket", () => ({ ticket: tickets.mint(), wsBase: opts.wsBase }))
    .ws("/ws/ahp", {
      open(ws) {
        const ticket = ws.data.query?.ticket;
        if (typeof ticket !== "string" || !tickets.consume(ticket)) {
          ws.close(4001, "invalid ticket");
          return;
        }
        connections.set(
          ws,
          server.createConnection((frame) => ws.send(frame)),
        );
      },
      message(ws, raw) {
        const connection = connections.get(ws);
        if (!connection) return;
        // Elysia 会预解析 JSON 帧，而 AHP 的帧就是 JSON：重新序列化即可。
        connection.handle(typeof raw === "string" ? raw : JSON.stringify(raw));
      },
      close(ws) {
        connections.get(ws)?.close();
        connections.delete(ws);
      },
    });

  return { server, routes };
}

/** 路由实例的具体类型（Elysia 的泛型不能宽化成 `Elysia`，否则 `.use()` 不收）。 */
export type AhpFace = ReturnType<typeof createAhpFace>;
