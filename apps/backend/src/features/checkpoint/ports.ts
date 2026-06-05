export interface CheckpointReadPort {
  getMessages(threadId: string): Promise<unknown[] | null>;
}
