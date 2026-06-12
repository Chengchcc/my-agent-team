export { DefaultWorkspaceAliases, isSharedLogicalPath, SharedOnlyAliases } from "./aliases.js";
export { LocalBackend, MemoryBackend } from "./backends.js";
export {
  makeDefaultMounts,
  makeDevWorkspaceHandle,
  makeExternalMount,
  makeSharedOnlyMounts,
  makeSharedOnlyWorkspaceFS,
  makeWorkspaceHandle,
} from "./mounts.js";
export type {
  MountEntry,
  PathAliasResolver,
  ReadableBackend,
  WorkspaceDomain,
  WritableBackend,
} from "./types.js";
export type { WorkspaceHandle } from "./workspace-fs.js";
export { WorkspaceAccessError, WorkspaceFS } from "./workspace-fs.js";
