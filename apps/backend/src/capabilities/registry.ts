import type { Tool } from "@my-agent-team/core";
import type { AgentExtension, Capability, CapabilityManifest } from "./types.js";

export class CapabilityRegistry {
  readonly #capabilities = new Map<string, Capability>();
  readonly #order: string[] = [];

  register(capability: Capability): void {
    if (this.#capabilities.has(capability.id)) {
      throw new Error(`Duplicate capability: ${capability.id}`);
    }
    this.#capabilities.set(capability.id, capability);
    this.#order.push(capability.id);
  }

  /** Collect all AgentExtensions from installed capabilities, in registration order. */
  collectExtensions(): AgentExtension {
    const hooks: NonNullable<AgentExtension["hooks"]> = {};
    const tools: Tool[] = [];
    const prompts: string[] = [];

    for (const id of this.#order) {
      const cap = this.#capabilities.get(id)!;
      if (cap.extendAgent) {
        // ponytail: sync only for now; async support added when needed
        const ext = cap.extendAgent({ agentId: "", sessionId: "", conversationId: "" });
        const resolved = ext instanceof Promise ? undefined : ext;
        if (resolved) {
          if (resolved.hooks) Object.assign(hooks, resolved.hooks);
          if (resolved.tools) tools.push(...resolved.tools);
          if (resolved.systemPrompt) prompts.push(resolved.systemPrompt);
        }
      }
    }

    // Tool name collision check
    const seen = new Set<string>();
    for (const t of tools) {
      if (seen.has(t.name)) throw new Error(`Tool name collision: ${t.name}`);
      seen.add(t.name);
    }

    return {
      hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
      tools: tools.length > 0 ? tools : undefined,
      systemPrompt: prompts.length > 0 ? prompts.join("\n\n") : undefined,
    };
  }

  /** Validate there are no collisions between registered capabilities. */
  validate(): void {
    this.collectExtensions(); // throws on tool collision
  }

  getManifests(): CapabilityManifest[] {
    return this.#order.map((id) => this.#capabilities.get(id)!.manifest ?? { id });
  }

  list(): readonly Capability[] {
    return this.#order.map((id) => this.#capabilities.get(id)!);
  }
}
