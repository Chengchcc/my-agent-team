import type { JsonRpcMessage, JsonRpcResponse } from '../contracts';
import type { DataPlaneEvent } from '../contracts';

/**
 * Transport port — unified interface bridging ControlPlane (JSON-RPC)
 * and DataPlane (event stream) into a single adapter that a Frontend can use.
 *
 * Implementations:
 *   - InMemoryTransport (infrastructure) — for in-process frontends (TUI, tests)
 *   - StdioTransport (future) — for stdio-based MCP-like frontends
 *   - WebSocketTransport (future) — for remote frontends
 */
interface Transport {
  /** Send JSON-RPC request and get response */
  sendRpc(message: JsonRpcMessage): Promise<JsonRpcResponse | null>;
  /** Subscribe to DataPlane events */
  onEvent(handler: (event: DataPlaneEvent) => void): () => void; // returns unsubscribe
  /** Close transport */
  close(): Promise<void>;
}

export type { Transport };
