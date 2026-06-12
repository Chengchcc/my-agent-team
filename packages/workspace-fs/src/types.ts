// ─── Domain ───

export type WorkspaceDomain = "shared" | "private" | "external" | "runner_state";

// ─── Backend interfaces ───

export interface ReadableBackend {
  read(relPath: string): Promise<string | null>;
  list(relPath: string): Promise<string[]>;
  stat(relPath: string): Promise<{ mtimeMs: number; size: number } | null>;
  exists(relPath: string): Promise<boolean>;
}

export interface WritableBackend extends ReadableBackend {
  write(relPath: string, content: string): Promise<void>;
  mkdirp(relPath: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

// ─── Mount table ───

export interface MountEntry {
  /** Absolute logical prefix, e.g. "/", "/memory/", "/.state/checkpoints/" */
  prefix: string;
  backend: ReadableBackend;
  domain: WorkspaceDomain;
  /** If set, this mount is visible to POSIX subprocesses under this root. */
  posixRoot?: string;
}

