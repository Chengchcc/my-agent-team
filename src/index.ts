// Lobster v2.0 — Public API
//
// Kernel framework
export { createKernel, defineExtension } from './kernel'
export type { Kernel, KernelConfig, KernelContext, ExtensionBuilder, ExtensionApplyResult } from './kernel'

// Domain entities
export * from './domain'

// Application ports
export type { TraceReader, MemoryStore, SessionStore, Transport } from './application'

// Extensions (barrel)
export { default as traceExt } from './extensions/trace'
export { default as providerExt } from './extensions/provider'
export { default as sessionExt } from './extensions/session'
export { default as memoryExt } from './extensions/memory'
export { default as identityExt } from './extensions/identity'
export { default as skillsExt } from './extensions/skills'
export { default as toolsExt } from './extensions/tools'
export { default as permissionExt } from './extensions/permission'
export { default as controlplaneExt } from './extensions/controlplane'
export { default as dataplaneExt } from './extensions/dataplane'
export { default as transportExt } from './extensions/transport.inmem'
export { default as evolutionExt } from './extensions/evolution'
export { default as mcpExt } from './extensions/mcp'

// Infrastructure adapters
export { EchoProvider } from './infrastructure/llm/echo-provider'
export { InMemorySessionStore } from './infrastructure/session/inmem-session-store'

// Frontend handle
export type { FrontendHandle } from './application/ports/frontend-handle'
