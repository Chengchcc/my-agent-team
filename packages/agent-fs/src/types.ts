export type AgentFsDomain = "shared" | "private" | "external";

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

/** Maps user-facing logical paths to AFS internal canonical paths. */
export interface PathAliasResolver {
  toCanonical(path: string): string;
}

export interface MountEntry {
  prefix: string;
  backend: ReadableBackend;
  domain: AgentFsDomain;
  posixRoot?: string;
}
