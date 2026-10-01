/** Client-side machinery shared by the AHP surfaces (ADR 0040: the surface contract is AHP).
 *
 *  Upstream brings the protocol, the state mirror and the reducers; the one thing it does not
 *  ship is a WebSocket transport. */

export type { AhpClientLike } from "./client.js";
export { enumValue } from "./enum-value.js";
export type { WebSocketTransportOptions } from "./transport.js";
export { createWebSocketTransport, createWebSocketTransportFactory } from "./transport.js";
export {
  AHP_CHAT_PREFIX,
  AHP_ROOT_URI,
  AHP_SESSION_PREFIX,
  chatUri,
  conversationIdFrom,
  sessionUri,
} from "./uris.js";
