// ── JSON-RPC 2.0 message types ────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Standard error codes ──────────────────────────────────────────────────────

export const JSONRPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  SESSION_NOT_FOUND: { code: -32000, message: 'Session not found' },
  SESSION_BUSY: { code: -32001, message: 'Session busy' },
  PERMISSION_TARGET_MISMATCH: { code: -32002, message: 'Permission target mismatch' },
} as const;

export type JsonRpcErrorCode = (typeof JSONRPC_ERRORS)[keyof typeof JSONRPC_ERRORS];

// ── Type guards / builders ────────────────────────────────────────────────────

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (msg as Record<string, unknown>).method === 'string'
  );
}

export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

export function buildSuccess(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function buildError(
  id: string | number | null,
  error: JsonRpcErrorCode | { code: number; message: string },
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { ...error, data } };
}
