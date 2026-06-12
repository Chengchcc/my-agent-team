export { LocalBackend, MemoryBackend } from "./backends.js";
export {
  makeDefaultMounts,
  makeDevWorkspaceHandle,
  makeExternalMount,
  makeSharedOnlyMounts,
  makeWorkspaceHandle,
} from "./mounts.js";
export type { MountEntry, ReadableBackend, WorkspaceDomain, WritableBackend } from "./types.js";
export type { WorkspaceHandle } from "./workspace-fs.js";
export { WorkspaceAccessError, WorkspaceFS } from "./workspace-fs.js";
