import path from "node:path";
import { LocalBackend, MemoryBackend } from "./backends.js";
import type { MountEntry } from "./types.js";
import type { WorkspaceHandle } from "./workspace-fs.js";
import { WorkspaceFS } from "./workspace-fs.js";

// ─── Default mount table ───

export function makeDefaultMounts(o: {
  sharedRoot: string;
  privateRoot: string;
  sharedPosix?: boolean;
}): MountEntry[] {
  const join = path.join;
  return [
    {
      prefix: "/memory/",
      domain: "shared",
      backend: new LocalBackend(join(o.sharedRoot, "memory")),
      posixRoot: o.sharedPosix ? join(o.sharedRoot, "memory") : undefined,
    },
    ...["SOUL.md", "USER.md", "BOOTSTRAP.md", "TOOLS.md", "AGENTS.md"].map(
      (name) =>
        ({
          prefix: `/${name}`,
          domain: "shared",
          backend: new LocalBackend(o.sharedRoot),
          posixRoot: o.sharedPosix ? o.sharedRoot : undefined,
        }) satisfies MountEntry,
    ),
    {
      prefix: "/",
      domain: "private",
      backend: new LocalBackend(o.privateRoot),
      posixRoot: o.privateRoot,
    },
  ];
}

export function makeWorkspaceHandle(o: {
  sharedRoot: string;
  privateRoot: string;
  sharedPosix?: boolean;
}): WorkspaceHandle {
  const mounts = makeDefaultMounts(o);
  const fs = new WorkspaceFS(mounts);
  return { fs, privateRoot: o.privateRoot, posixRoots: fs.posixRoots() };
}

export function makeDevWorkspaceHandle(root: string): WorkspaceHandle {
  const sharedRoot = path.join(root, "shared");
  const privateRoot = path.join(root, "private");
  return makeWorkspaceHandle({ sharedRoot, privateRoot, sharedPosix: true });
}

// ─── Shared-only view (for backend) ───

export function makeSharedOnlyMounts(o: {
  sharedRoot: string;
  sharedPosix?: boolean;
}): MountEntry[] {
  const join = path.join;
  return [
    {
      prefix: "/memory/",
      domain: "shared",
      backend: new LocalBackend(join(o.sharedRoot, "memory")),
      posixRoot: o.sharedPosix ? join(o.sharedRoot, "memory") : undefined,
    },
    ...["SOUL.md", "USER.md", "BOOTSTRAP.md", "TOOLS.md", "AGENTS.md"].map(
      (name) =>
        ({
          prefix: `/${name}`,
          domain: "shared",
          backend: new LocalBackend(o.sharedRoot),
          posixRoot: o.sharedPosix ? o.sharedRoot : undefined,
        }) satisfies MountEntry,
    ),
    // No "/" private root — backend cannot access private files
  ];
}

// ─── External mount helper (for testing) ───

export function makeExternalMount(prefix: string): MountEntry {
  return {
    prefix,
    domain: "external",
    backend: new MemoryBackend(),
    posixRoot: undefined,
  };
}
