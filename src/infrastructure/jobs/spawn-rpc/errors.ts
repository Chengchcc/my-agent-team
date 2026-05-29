export type WorkerRpcCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'PURPOSE_NOT_ALLOWED'
  | 'PROVIDER_ERROR'
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_EXEC_FAIL'
  | 'TOOL_TIMEOUT'
  | 'WORKER_FATAL'
  | 'PROTOCOL_VIOLATION'
  | 'WORKER_CRASHED'
  | 'UNKNOWN'

export class WorkerRpcError extends Error {
  public override readonly name = 'WorkerRpcError'

  constructor(
    public readonly code: WorkerRpcCode,
    message: string,
    public readonly frameId?: string,
  ) {
    super(message)
  }
}
