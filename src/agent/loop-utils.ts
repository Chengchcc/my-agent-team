export const MAX_EPHEMERAL_BYTES = 4096;
export const PRIORITY_SKILL_HINT = 1;
export const PRIORITY_TODO_STATUS = 2;
export const PRIORITY_RETRIEVED_MEMORY = 3;
export const PRIORITY_UNKNOWN = 4;
export const NANOID_LENGTH = 6;
export const MAX_STREAM_RETRIES = 4;
export const RETRY_BASE_DELAY_MS = 1000;
export const COMPACTION_TIER_FULL = 4;

export type StreamErrorKind = 'network' | 'rate_limit' | 'fatal';

export function classifyStreamError(error: Error): StreamErrorKind {
  const msg = error.message.toLowerCase();
  if (msg.includes('timeout') || msg.includes('network') ||
      msg.includes('econnrefused') || msg.includes('enotfound') ||
      msg.includes('etimedout') || msg.includes('fetch failed') ||
      msg.includes('econnreset')) {
    return 'network';
  }
  if (msg.includes('rate_limit') || msg.includes('429') ||
      msg.includes('too many requests')) {
    return 'rate_limit';
  }
  return 'fatal';
}

export function retryDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Truncate ephemeral reminders to fit within MAX_EPHEMERAL_BYTES.
 * Priority (highest first): skill_hint > todo_status > retrieved_memory.
 * Within same priority, earlier reminders are kept first.
 */
export function truncateEphemeralReminders(reminders: string[]): string[] {
  const totalBytes = reminders.reduce((sum, r) => sum + Buffer.byteLength(r, 'utf8'), 0);
  if (totalBytes <= MAX_EPHEMERAL_BYTES) return reminders;

  const priority = (r: string): number => {
    if (r.includes('<skill_hint')) return PRIORITY_SKILL_HINT;
    if (r.includes('<todo_status')) return PRIORITY_TODO_STATUS;
    if (r.includes('<retrieved_memory')) return PRIORITY_RETRIEVED_MEMORY;
    return PRIORITY_UNKNOWN;
  };

  const indexed = reminders.map((text, idx) => ({ text, priority: priority(text), idx }));
  indexed.sort((a, b) => a.priority - b.priority || a.idx - b.idx);

  let used = 0;
  const keep: string[] = [];
  for (const item of indexed) {
    const size = Buffer.byteLength(item.text, 'utf8');
    if (used + size <= MAX_EPHEMERAL_BYTES) {
      keep.push(item.text);
      used += size;
    }
  }
  return keep;
}
