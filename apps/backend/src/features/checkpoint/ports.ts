export interface CheckpointReadPort {
  getMessages(threadId: string): Promise<unknown[] | null>;
}

/** M10: Write port for broadcast projection — backend appends messages to agent threads. */
export interface CheckpointWritePort {
  appendMessages(threadId: string, msgs: unknown[]): Promise<void>;
}
