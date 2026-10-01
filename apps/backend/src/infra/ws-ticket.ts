/** 一次性 WebSocket 票据。
 *
 *  浏览器建立 WebSocket 时带不了自定义头，所以在 upgrade 阶段用「先换票、再凭票
 *  连接」完成鉴权：`POST .../ws-ticket` 发票，`open()` 里核票。票据一次性使用、
 *  默认 60 秒过期，`mint` 时顺手清掉过期项。 */
import { randomBytes } from "node:crypto";

export interface WsTicketRegistry {
  mint(): string;
  consume(ticket: string): boolean;
}

export const DEFAULT_WS_TICKET_TTL_MS = 60_000;

export function createWsTicketRegistry(
  opts: { readonly ttlMs?: number; readonly now?: () => number } = {},
): WsTicketRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_WS_TICKET_TTL_MS;
  const now = opts.now ?? Date.now;
  const tickets = new Map<string, number>();

  return {
    mint() {
      const ticket = randomBytes(32).toString("hex");
      tickets.set(ticket, now() + ttlMs);
      for (const [key, expiry] of tickets) if (expiry < now()) tickets.delete(key);
      return ticket;
    },
    consume(ticket) {
      const expiry = tickets.get(ticket);
      tickets.delete(ticket);
      return expiry !== undefined && expiry >= now();
    },
  };
}
