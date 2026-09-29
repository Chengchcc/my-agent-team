/** AHP 客户端侧的共享机械（ADR 0040：surface 契约归 AHP）。
 *
 *  上游包提供协议、状态镜像与 reducer；这里补的只有它没带的那半 —— WebSocket 传输。 */

export type { WebSocketTransportOptions } from "./transport.js";
export { createWebSocketTransport, createWebSocketTransportFactory } from "./transport.js";
