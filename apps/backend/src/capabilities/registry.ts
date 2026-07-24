import type { AgentExtension, ResolvedExtension } from "@my-agent-team/agent";
import { composeExtensions } from "@my-agent-team/agent";
import type { Tool } from "@my-agent-team/core";
import type {
  AgentScope,
  Capability,
  CapabilityManifest,
  CapabilityServerContext,
} from "./types.js";

export class CapabilityRegistry {
  readonly #caps = new Map<string, Capability>();
  readonly #order: string[] = [];

  register(cap: Capability): void {
    if (this.#caps.has(cap.id)) throw new Error(`Duplicate capability: ${cap.id}`);
    this.#caps.set(cap.id, cap);
    this.#order.push(cap.id);
  }

  list(): readonly Capability[] {
    return this.#order.map((id) => this.#caps.get(id)!);
  }

  async collectExtensions(
    scope: AgentScope,
    baseTools: readonly Tool[] = [],
    baseSystemPrompt?: string,
  ): Promise<AgentExtension> {
    const resolved: ResolvedExtension[] = [];
    for (const capId of this.#order) {
      const cap = this.#caps.get(capId)!;
      if (!cap.extendAgent) continue;
      const ext = await cap.extendAgent(scope);
      resolved.push({ id: capId, extension: ext });
    }
    return composeExtensions({ resolved, baseTools, baseSystemPrompt });
  }

  async installServer(ctx: CapabilityServerContext): Promise<void> {
    for (const capId of this.#order) {
      await this.#caps.get(capId)!.installServer?.(ctx);
    }
  }

  getManifests(): CapabilityManifest[] {
    return this.#order.map((capId) => this.#caps.get(capId)!.manifest ?? { id: capId });
  }
}
