/** L1: Canonical contract for an agent-accessible virtual filesystem.
 *  Logical paths (slash-separated), multi-mount aggregation.
 *  Every AgentFS implementation must satisfy this contract.
 *
 *  For the backend-layer contract (relative paths, single mount point)
 *  see @my-agent-team/agent-fs ReadableBackend/WritableBackend. */
export interface AgentFsLike {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
}

/** Join path segments with "/" — logical paths, not OS paths. */
export const pjoin = (...s: string[]) => s.join("/").replace(/\/+/g, "/");
