import type { AgentHooks } from "@my-agent-team/agent";
import type { Tool } from "@my-agent-team/core";

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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TypedRoute {}

export type CommandHandler = (input: string) => string | Promise<string>;

export interface CapabilityServerContext {
  registerRoute(route: TypedRoute): void;
  registerCommand(name: string, handler: CommandHandler): void;
}

export interface Capability {
  readonly id: string;
  extendAgent?(scope: AgentScope): AgentExtension | Promise<AgentExtension>;
  installServer?(ctx: CapabilityServerContext): void | Promise<void>;
  readonly manifest?: CapabilityManifest;
}
