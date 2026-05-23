import { NdjsonCheckpointer } from './ndjson-checkpointer'
export function createNdjsonCheckpointer(
  baseDir: string,
  agentId?: string,
): NdjsonCheckpointer {
  return new NdjsonCheckpointer(baseDir, agentId ?? 'default')
}
