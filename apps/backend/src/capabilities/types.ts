import type { AgentHooks } from "@my-agent-team/agent";
import type { Tool } from "@my-agent-team/core";

/** Agent extension contributed by a Capability. */
export interface AgentExtension {
  hooks?: AgentHooks;
  tools?: readonly Tool[];
  systemPrompt?: string;
}

/** Manifest describing a Capability's UI slots. */
export interface CapabilityManifest {
  id: string;
  slots?: readonly string[];
}

/** Scope identifying which Agent instance a Capability is extending. */
export interface AgentScope {
  agentId: string;
  sessionId: string;
  conversationId?: string;
}

/** Context for server-side installation (routes, commands). */
export type CapabilityServerContext = { readonly _brand?: undefined };

/**
 * A Capability — self-contained module that extends Agent + Gateway + UI.
 */
export interface Capability {
  readonly id: string;
  extendAgent?(scope: AgentScope): AgentExtension | Promise<AgentExtension>;
  installServer?(ctx: CapabilityServerContext): void | Promise<void>;
  readonly manifest?: CapabilityManifest;
}
