export { DefaultWorkspaceAliases, SharedOnlyAliases, isSharedLogicalPath } from "./aliases.js";
export { LocalBackend, MemoryBackend } from "./backends.js";
export { makeDefaultMounts, makeDevWorkspaceHandle, makeExternalMount, makeSharedOnlyMounts, makeSharedOnlyWorkspaceFS, makeWorkspaceHandle } from "./mounts.js";
export type { MountEntry, PathAliasResolver, ReadableBackend, WritableBackend, WorkspaceDomain } from "./types.js";
export type { WorkspaceHandle } from "./workspace-fs.js";
export { WorkspaceAccessError, WorkspaceFS } from "./workspace-fs.js";
