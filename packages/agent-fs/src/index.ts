export type { AgentFsHandle } from "./agent-fs.js";
export { AgentFS, AgentFsAccessError } from "./agent-fs.js";
export { DefaultWorkspaceAliases, isSharedLogicalPath, SharedOnlyAliases } from "./aliases.js";
export { LocalBackend, MemoryBackend } from "./backends.js";
export {
  makeAgentFsHandle,
  makeDefaultMounts,
  makeDevAgentFsHandle,
  makeExternalMount,
  makeSharedOnlyAgentFS,
  makeSharedOnlyMounts,
} from "./mounts.js";
export type {
  AgentFsDomain,
  MountEntry,
  PathAliasResolver,
  ReadableBackend,
  WritableBackend,
} from "./types.js";
