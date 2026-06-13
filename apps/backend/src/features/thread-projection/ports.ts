export interface ThreadProjectionReadPort {
  getMessages(threadId: string): Promise<unknown[] | null>;
}

/** Write port for broadcast projection — backend projects conversation ledger
 *  entries into agent-thread messages. Distinct from the runner daemon's
 *  runtime {@link Checkpointer} which handles execution-state persistence. */
export interface ThreadProjectionWritePort {
  appendMessages(threadId: string, msgs: unknown[]): Promise<void>;
}
