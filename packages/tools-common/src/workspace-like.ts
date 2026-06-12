/** M14.7: Structured IO interface for logical-path file operations.
 *  WorkspaceFS implements this naturally via structural typing. */
export interface WorkspaceLike {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
}

/** Join path segments with "/" — logical paths, not OS paths. */
export const pjoin = (...s: string[]) => s.join("/").replace(/\/+/g, "/");
