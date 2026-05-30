import type { SessionStore } from '../application/ports/session-store'
import type { SessionHistoryPort } from '../application/ports/session-history'
import type { ProviderChat, ProviderInvoke } from '../application/ports/provider'
import type { TraceReader } from '../application/ports/trace-checkpointer'
import type { ToolCatalog } from '../application/ports/tool-catalog'
import type { MemoryStore } from '../application/ports/memory-store'
import type { JobSpawner } from '../application/ports/job-spawner'
import type { ProposalStore } from '../application/ports/proposal-store'
import type { SkillStatsStore } from '../application/ports/skill-stats-store'
import type { SkillMetaRepo } from '../application/ports/skill-meta-repo'
import type { Transport } from '../application/ports/transport'
import type { FrontendHandle } from '../application/ports/frontend-handle'
import type { AgentRegistryRead, AgentSelfMutator } from '../application/ports/agent-registry'
import type { Compactor } from '../application/usecases/compact-session'
import type { DataPlaneEvent, DataPlaneEventType, JsonRpcMessage, JsonRpcResponse } from '../application/contracts'
import type { SkillDescriptor } from '../domain/skill-descriptor'
import type { MemoryEntry } from '../domain/memory-entry'
import type { ToolDescriptor } from '../domain/turn-runner.types'

/**
 * CapabilityMap — every capability key registered by extensions mapped to its port type.
 *
 * Keys follow the `extension.capability` convention.
 * When an extension registers `provide: { 'ext.cap': () => value }`,
 * consumers retrieve it via `ctx.extensions.get('ext.cap')` with full type safety.
 */
export interface CapabilityMap {
  // ── provider ──────────────────────────────────────────────────────
  'provider.llm': ProviderChat & ProviderInvoke

  // ── trace ─────────────────────────────────────────────────────────
  'trace.reader': TraceReader

  // ── tool-catalog ──────────────────────────────────────────────────
  'tool-catalog.catalog': ToolCatalog

  // ── session ───────────────────────────────────────────────────────
  'session.store': SessionStore
  'session.history': SessionHistoryPort
  'session.compactor': Compactor
  'session.abort': SessionAbortController
  'session.messages': SessionMessagesStore

  // ── memory ────────────────────────────────────────────────────────
  'memory.store': MemoryStore
  'memory.recall': RecallAPICapability

  // ── identity ──────────────────────────────────────────────────────
  'identity.store': IdentityStoreCapability

  // ── dataplane ─────────────────────────────────────────────────────
  'dataplane.register': DataPlaneRegisterFn
  'dataplane.stream': DataPlaneStreamCapability

  // ── mcp ───────────────────────────────────────────────────────────
  'mcp.manager': McpManagerCapability

  // ── skills ────────────────────────────────────────────────────────
  'skills.registry': SkillsRegistryCapability

  // ── permission ────────────────────────────────────────────────────
  'permission.checker': PermissionCheckerCapability

  // ── sub-agent ─────────────────────────────────────────────────────
  'sub-agent.registry': SubAgentRegistryCapability

  // ── session-mode ──────────────────────────────────────────────────
  'session-mode.registry': SessionModeRegistryCapability

  // ── agent (kernel-provided) ───────────────────────────────────────
  'agent.registry': AgentRegistryRead
  'agent.self': AgentSelfMutator

  // ── frontend-tui ──────────────────────────────────────────────────
  'frontend-tui.tui': FrontendHandle

  // ── frontend-lark ─────────────────────────────────────────────────
  'frontend-lark.lark': LarkBotCapability

  // ── transport-inmem ───────────────────────────────────────────────
  'transport-inmem.transport': Transport

  // ── controlplane ──────────────────────────────────────────────────
  'controlplane.server': ControlPlaneServerCapability

  // ── infra-services ────────────────────────────────────────────────
  'infra-services.job-spawner': JobSpawner
  'infra-services.proposal-store': ProposalStore
  'infra-services.skill-stats-store': SkillStatsStore
  'infra-services.skill-meta-repo': SkillMetaRepo
  'infra-services.job-context-factory': JobContextFactoryCapability | undefined
}

/** All valid capability key strings. */
export type CapabilityKey = keyof CapabilityMap

// ── Inline capability types (no formal port interface exists) ──────

/** Session abort controller registry. */
export interface SessionAbortController {
  register(sessionId: string, controller: AbortController): void
  unregister(sessionId: string): void
  abort(sessionId: string): void
  waitDrained(sessionId: string, timeoutMs: number): Promise<void>
}

/** Lightweight session message accessor (optional, consumed only in controlplane attach). */
export interface SessionMessagesStore {
  get(sessionId: string): Array<{ role: string; content: string }>
}

/** Identity store — file-backed identity persistence. */
export interface IdentityStoreCapability {
  hydrationDone: Promise<void>
  current(): { agentId: string; fields: Readonly<Record<string, string>>; body: string; version: number; updatedAt: number }
  getDraftPath(): string
  hydrate(fields: Record<string, string>, body: string, source: 'file' | 'bootstrap'): void
}

/** DataPlane register mapping function. */
export type DataPlaneRegisterFn = (
  rawType: string,
  mapper: (raw: unknown) => {
    dpType: DataPlaneEventType
    payload: Record<string, unknown>
    sessionId?: string
    turnId?: string
  },
) => void

/** DataPlane event stream for frontend subscription. */
export interface DataPlaneStreamCapability {
  replay(since?: number): DataPlaneEvent[]
  getCursor(): number
  getEventCount(): number
  clear(): void
}

/** Memory recall API — search across stored memories. */
export interface RecallAPICapability {
  search(query: string, opts?: { limit?: number }): Promise<MemoryEntry[]>
}

/** MCP manager (multi-server protocol). */
export interface McpManagerCapability {
  connectServer(config: { name: string; transport?: string; command?: string; args?: string[]; env?: Record<string, string> }): Promise<void>
  disconnectServer(name: string): Promise<void>
  shutdown(): Promise<void>
}

/** Job context factory — creates per-run JobContext from (opts: { runId: string }). */
export type JobContextFactoryCapability = (opts: { runId: string }) => {
  invoke: (req: { purpose: string; messages: Array<{ role: string; content: string }>; maxTokens?: number }) => Promise<{ content: string; usage: { input: number; output: number } }>
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/** Skills registry. */
export interface SkillsRegistryCapability {
  list(scope?: string): SkillDescriptor[]
  get(name: string): SkillDescriptor | undefined
  register(skill: SkillDescriptor): void
}

/** Permission checker. */
export interface PermissionCheckerCapability {
  check(toolName: string, sessionId?: string): boolean
  deny(toolName: string): void
  allowOnce(sessionId: string, toolName: string): void
}

/** Sub-agent registry. */
export interface SubAgentRegistryCapability {
  register(desc: SubAgentDescriptorShape): void
  get(type: string): SubAgentDescriptorShape | undefined
  list(): SubAgentDescriptorShape[]
  clear(): void
}

export interface SubAgentDescriptorShape {
  type: string
  description: string
  systemPrompt: string
  allowedToolNames: readonly string[]
  maxRounds?: number
  maxOutputTokens?: number
  modelHint?: 'fast' | 'strong'
  source: 'builtin' | 'extension'
}

/** Session-mode registry. */
export interface SessionModeRegistryCapability {
  register(desc: ModeDescriptorShape): void
  get(name: string): ModeDescriptorShape | undefined
  list(): ModeDescriptorShape[]
}

export interface ModeDescriptorShape {
  name: string
  description: string
  systemPromptAppend: string
  toolFilter: (tool: ToolDescriptor) => boolean
  source: 'builtin' | 'extension'
}

/** Lark bot capability — factory for creating Lark bot adapters. */
export interface LarkBotCapability {
  createBot(config: { id: string; appId: string; appSecretEnv: string }): FrontendHandle
}

/** ControlPlane server handle — JSON-RPC dispatch + frontend attachment management. */
export interface ControlPlaneServerCapability {
  handle(message: JsonRpcMessage): Promise<JsonRpcResponse | null>
  attachFrontend(frontendId: string, sessionId: string): void
  detachFrontend(frontendId: string, sessionId: string): void
}
