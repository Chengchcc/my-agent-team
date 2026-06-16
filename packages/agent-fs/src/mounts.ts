import path from "node:path";
import type { AgentFsHandle } from "./agent-fs.js";
import { AgentFS } from "./agent-fs.js";
import { SharedOnlyAliases } from "./aliases.js";
import { LocalBackend, MemoryBackend } from "./backends.js";
import type { MountEntry } from "./types.js";

export function makeDefaultMounts(o: {
  sharedRoot: string;
  privateRoot: string;
  sharedPosix?: boolean;
}): MountEntry[] {
  return [
    {
      prefix: "/shared/",
      domain: "shared",
      backend: new LocalBackend(o.sharedRoot),
      posixRoot: o.sharedPosix ? o.sharedRoot : undefined,
    },
    {
      prefix: "/private/",
      domain: "private",
      backend: new LocalBackend(o.privateRoot),
      posixRoot: o.privateRoot,
    },
  ];
}

export function makeAgentFsHandle(o: {
  sharedRoot: string;
  privateRoot: string;
  sharedPosix?: boolean;
}): AgentFsHandle {
  const fs = new AgentFS({ mounts: makeDefaultMounts(o) });
  return { fs, privateRoot: o.privateRoot, posixRoots: fs.posixRoots(), displayRoot: "/" };
}

export function makeDevAgentFsHandle(root: string): AgentFsHandle {
  const sharedRoot = path.join(root, "shared");
  const privateRoot = path.join(root, "private");
  return makeAgentFsHandle({ sharedRoot, privateRoot, sharedPosix: true });
}

export function makeSharedOnlyMounts(o: {
  sharedRoot: string;
  sharedPosix?: boolean;
}): MountEntry[] {
  return [
    {
      prefix: "/shared/",
      domain: "shared",
      backend: new LocalBackend(o.sharedRoot),
      posixRoot: o.sharedPosix ? o.sharedRoot : undefined,
    },
  ];
}

export function makeSharedOnlyAgentFS(o: { sharedRoot: string }): AgentFS {
  return new AgentFS({ mounts: makeSharedOnlyMounts(o), aliases: new SharedOnlyAliases() });
}

export function makeExternalMount(prefix: string): MountEntry {
  return { prefix, domain: "external", backend: new MemoryBackend(), posixRoot: undefined };
}
