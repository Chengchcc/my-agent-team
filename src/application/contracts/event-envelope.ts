/**
 * Every cross-boundary observable event is wrapped in this versioned envelope.
 * sessionId / turnId are provided by the envelope so individual payloads
 * don't need to repeat them.
 */
export interface EventEnvelope<TType extends string, TPayload = Record<string, unknown>> {
  type: TType;
  version: 1;
  ts: number;
  sessionId?: string;
  turnId?: string;
  payload: TPayload;
}

/**
 * Factory options — populated from KernelContext at emit time.
 */
export interface CreateEventOpts {
  sessionId?: string;
  turnId?: string;
}

/**
 * Create a contracted event envelope. Called by extensions at emit points.
 */
export function createEvent<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  opts?: CreateEventOpts,
): EventEnvelope<TType, TPayload> {
  return {
    type,
    version: 1,
    ts: Date.now(),
    sessionId: opts?.sessionId,
    turnId: opts?.turnId,
    payload,
  };
}
