import type { AgentHooks } from "@my-agent-team/agent";
import type { ChatModel, Tool } from "@my-agent-team/core";

// ── Agent extension (registry output) ──

export interface AgentExtension {
  hooks?: AgentHooks;
  tools?: readonly Tool[];
  systemPrompt?: string;
}

export interface ResolvedExtension {
  capabilityId: string;
  extension: AgentExtension;
}

export interface CapabilityManifest {
  id: string;
  slots?: readonly string[];
}

export interface AgentScope {
  agentId: string;
  sessionId: string;
  conversationId?: string;
  memberId?: string;
  cwd: string;
}

// ── Server-side installation ──

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type TypedRoute = {};

export type CommandHandler = (input: string) => string | Promise<string>;

export interface CapabilityServerContext {
  registerRoute(route: TypedRoute): void;
  registerCommand(name: string, handler: CommandHandler): void;
}

// ── Capability (the stored unit, created by a factory closure) ──

export interface Capability {
  readonly id: string;
  extendAgent?(scope: AgentScope): AgentExtension | Promise<AgentExtension>;
  installServer?(ctx: CapabilityServerContext): void | Promise<void>;
  readonly manifest?: CapabilityManifest;
}

// ── Backend infrastructure (created once by main.ts) ──

/** Process-level shared services. Never given to Agent or packages/agent. */
export interface BackendInfrastructure {
  modelRegistry: { get(name: string): ChatModel };
  settings: {
    get(key: string): string | undefined;
    getNumber(key: string): Promise<number | undefined>;
    set(key: string, value: string | number): void | Promise<void>;
  };
  fs: { cwd: string; read(path: string): string; write(path: string, content: string): void };
  sse: { emit(event: string, data: unknown): void };
}

// ── Capability-specific dependency types ──

/** Memory capability: needs modelRegistry + settings + fs. Owns MemoryService. */
export interface MemoryCapabilityDeps {
  modelRegistry: BackendInfrastructure["modelRegistry"];
  settings: BackendInfrastructure["settings"];
  fs: BackendInfrastructure["fs"];
}

/** Pet capability: needs modelRegistry + settings + fs. Owns PetService. */
export interface PetCapabilityDeps {
  modelRegistry: BackendInfrastructure["modelRegistry"];
  settings: BackendInfrastructure["settings"];
  fs: BackendInfrastructure["fs"];
}

/** Recap capability: needs modelRegistry. Owns RecapService. */
export interface RecapCapabilityDeps {
  modelRegistry: BackendInfrastructure["modelRegistry"];
}

/** Identity capability: needs fs (for SOUL.md/USER.md). Owns AgentIdentityStore. */
export interface IdentityCapabilityDeps {
  fs: BackendInfrastructure["fs"];
}

/** Conversation-context capability: no business deps — pure tool injection. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type ConversationContextDeps = {};

// ── Narrow shared ports (for capability-to-capability communication) ──

/** Port exposed by the Memory capability for other capabilities to query. */
export interface MemoryReader {
  search(
    query: string,
    scope: { agentId: string },
  ): Promise<readonly { content: string; score: number }[]>;
}
