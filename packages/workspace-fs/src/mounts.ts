import path from "node:path";
import { SharedOnlyAliases } from "./aliases.js";
import { LocalBackend, MemoryBackend } from "./backends.js";
import type { MountEntry } from "./types.js";
import type { WorkspaceHandle } from "./workspace-fs.js";
import { WorkspaceFS } from "./workspace-fs.js";

export function makeDefaultMounts(o: {
  sharedRoot: string;
  privateRoot: string;
  sharedPosix?: boolean;
}): MountEntry[] {
  return [
    { prefix: "/shared/", domain: "shared", backend: new LocalBackend(o.sharedRoot), posixRoot: o.sharedPosix ? o.sharedRoot : undefined },
    { prefix: "/private/", domain: "private", backend: new LocalBackend(o.privateRoot), posixRoot: o.privateRoot },
  ];
}

export function makeWorkspaceHandle(o: {
  sharedRoot: string;
  privateRoot: string;
  sharedPosix?: boolean;
}): WorkspaceHandle {
  const fs = new WorkspaceFS({ mounts: makeDefaultMounts(o) });
  return { fs, privateRoot: o.privateRoot, posixRoots: fs.posixRoots(), displayRoot: "/" };
}

export function makeDevWorkspaceHandle(root: string): WorkspaceHandle {
  const sharedRoot = path.join(root, "shared");
  const privateRoot = path.join(root, "private");
  return makeWorkspaceHandle({ sharedRoot, privateRoot, sharedPosix: true });
}

export function makeSharedOnlyMounts(o: { sharedRoot: string; sharedPosix?: boolean }): MountEntry[] {
  return [
    { prefix: "/shared/", domain: "shared", backend: new LocalBackend(o.sharedRoot), posixRoot: o.sharedPosix ? o.sharedRoot : undefined },
  ];
}

export function makeSharedOnlyWorkspaceFS(o: { sharedRoot: string }): WorkspaceFS {
  return new WorkspaceFS({ mounts: makeSharedOnlyMounts(o), aliases: new SharedOnlyAliases() });
}

export function makeExternalMount(prefix: string): MountEntry {
  return { prefix, domain: "external", backend: new MemoryBackend(), posixRoot: undefined };
}
