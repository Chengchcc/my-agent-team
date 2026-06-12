export { DefaultWorkspaceAliases, isSharedLogicalPath, SharedOnlyAliases } from "./aliases.js";
export { LocalBackend, MemoryBackend } from "./backends.js";
export {
  makeDefaultMounts,
  makeDevAgentFsHandle,
  makeExternalMount,
  makeSharedOnlyMounts,
  makeSharedOnlyAgentFS,
  makeAgentFsHandle,
} from "./mounts.js";
export type {
  MountEntry,
  PathAliasResolver,
  ReadableBackend,
  AgentFsDomain,
  WritableBackend,
} from "./types.js";
export type { AgentFsHandle } from "./agent-fs.js";
export { AgentFsAccessError, AgentFS } from "./agent-fs.js";
