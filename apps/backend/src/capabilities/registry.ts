import type { AgentHooks } from "@my-agent-team/agent";
import type { Tool } from "@my-agent-team/core";
import type {
  AgentExtension,
  AgentScope,
  Capability,
  CapabilityManifest,
  CapabilityServerContext,
  ResolvedExtension,
} from "./types.js";

// ── Hook contribution collector ──

type BeforeRunHandler = NonNullable<AgentHooks["before:run"]>;
type BeforeModelHandler = NonNullable<AgentHooks["before:model"]>;
type AfterModelHandler = NonNullable<AgentHooks["after:model"]>;
type BeforeToolHandler = NonNullable<AgentHooks["before:tool"]>;
type AfterToolHandler = NonNullable<AgentHooks["after:tool"]>;
type AfterTurnHandler = NonNullable<AgentHooks["after:turn"]>;
type BeforeStopHandler = NonNullable<AgentHooks["before:stop"]>;

interface HookContributions {
  beforeRun: BeforeRunHandler[];
  beforeModel: BeforeModelHandler[];
  afterModel: AfterModelHandler[];
  beforeTool: BeforeToolHandler[];
  afterTool: AfterToolHandler[];
  afterTurn: AfterTurnHandler[];
  beforeStop: BeforeStopHandler[];
}

function emptyContributions(): HookContributions {
  return {
    beforeRun: [],
    beforeModel: [],
    afterModel: [],
    beforeTool: [],
    afterTool: [],
    afterTurn: [],
    beforeStop: [],
  };
}

function collectContributions(resolved: readonly ResolvedExtension[]): HookContributions {
  const r = emptyContributions();
  for (const { extension } of resolved) {
    const h = extension.hooks;
    if (!h) continue;
    if (h["before:run"]) r.beforeRun.push(h["before:run"]);
    if (h["before:model"]) r.beforeModel.push(h["before:model"]);
    if (h["after:model"]) r.afterModel.push(h["after:model"]);
    if (h["before:tool"]) r.beforeTool.push(h["before:tool"]);
    if (h["after:tool"]) r.afterTool.push(h["after:tool"]);
    if (h["after:turn"]) r.afterTurn.push(h["after:turn"]);
    if (h["before:stop"]) r.beforeStop.push(h["before:stop"]);
  }
  return r;
}

// ── Hook compositors ──

function composeBeforeRun(handlers: readonly BeforeRunHandler[]): AgentHooks["before:run"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, input) => {
    let cur = input;
    for (const h of handlers) {
      const next = await h(ctx, cur);
      if (next) cur = next;
    }
    return cur;
  };
}

function composeBeforeModel(handlers: readonly BeforeModelHandler[]): AgentHooks["before:model"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, messages) => {
    let cur = [...messages];
    for (const h of handlers) cur = [...(await h(ctx, cur))];
    return cur;
  };
}

function composeObservers<TArgs extends unknown[]>(
  handlers: readonly ((...args: TArgs) => void | Promise<void>)[],
): (...args: TArgs) => Promise<void> {
  return async (...args) => {
    for (const h of handlers) await h(...args);
  };
}

function composeBeforeTool(handlers: readonly BeforeToolHandler[]): AgentHooks["before:tool"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, call) => {
    let cur = call;
    for (const h of handlers) {
      const d = await h(ctx, cur);
      if (!d) continue;
      if (d.skip || d.result !== undefined) return d;
      if (d.input !== undefined) cur = { ...cur, input: d.input };
    }
    return undefined;
  };
}

function composeBeforeStop(handlers: readonly BeforeStopHandler[]): AgentHooks["before:stop"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, messages) => {
    const reasons: string[] = [];
    for (const h of handlers) {
      const d = await h(ctx, messages);
      if (d?.continue) reasons.push(d.reason);
    }
    return reasons.length > 0 ? { continue: true, reason: reasons.join("\n\n") } : undefined;
  };
}

// ── Tool merge ──

function mergeTools(resolved: readonly ResolvedExtension[], baseTools: readonly Tool[]): Tool[] {
  const result = [...baseTools];
  const owners = new Map<string, string>();
  for (const t of baseTools) owners.set(t.name, "base");
  for (const { capabilityId, extension } of resolved) {
    for (const t of extension.tools ?? []) {
      const prev = owners.get(t.name);
      if (prev) throw new Error(`Tool name collision: ${t.name}; ${prev} vs ${capabilityId}`);
      owners.set(t.name, capabilityId);
      result.push(t);
    }
  }
  return result;
}

function mergeSystemPrompts(exts: readonly AgentExtension[]): string | undefined {
  const parts = exts.map((x) => x.systemPrompt).filter((x): x is string => Boolean(x));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function hasAnyHooks(hooks: AgentHooks): boolean {
  return Object.values(hooks).some((v) => v != null);
}

async function mergeExtensions(
  resolved: readonly ResolvedExtension[],
  baseTools: readonly Tool[],
): Promise<AgentExtension> {
  const c = collectContributions(resolved);
  const hooks: AgentHooks = {
    "before:run": composeBeforeRun(c.beforeRun),
    "before:model": composeBeforeModel(c.beforeModel),
    "after:model": composeObservers(c.afterModel),
    "before:tool": composeBeforeTool(c.beforeTool),
    "after:tool": composeObservers(c.afterTool),
    "after:turn": composeObservers(c.afterTurn),
    "before:stop": composeBeforeStop(c.beforeStop),
  };
  const allTools = mergeTools(resolved, baseTools);
  return {
    hooks: hasAnyHooks(hooks) ? hooks : undefined,
    tools: allTools.length > 0 ? allTools : undefined,
    systemPrompt: mergeSystemPrompts(resolved.map((r) => r.extension)),
  };
}

// ── Registry ──

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
  ): Promise<AgentExtension> {
    const resolved: ResolvedExtension[] = [];
    for (const id of this.#order) {
      const cap = this.#caps.get(id)!;
      if (!cap.extendAgent) continue;
      resolved.push({ capabilityId: cap.id, extension: await cap.extendAgent(scope) });
    }
    return mergeExtensions(resolved, baseTools);
  }

  async installServer(ctx: CapabilityServerContext): Promise<void> {
    for (const id of this.#order) {
      await this.#caps.get(id)!.installServer?.(ctx);
    }
  }

  getManifests(): CapabilityManifest[] {
    return this.#order.map((id) => this.#caps.get(id)!.manifest ?? { id });
  }
}
