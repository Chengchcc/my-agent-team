import type { Model, ModelRegistry } from "./types.js";

/**
 * Resolve a model reference string to a Model object.
 *
 *   "provider/id"  → registry.getModel(provider, id)  // preferred format
 *   "bare-id"      → search all providers (legacy compat, first match wins)
 *
 * Throws if not found so callers don't silently fall back.
 */
export function resolveModel(name: string, registry: ModelRegistry): Model {
  const slash = name.indexOf("/");
  if (slash > 0) {
    const provider = name.slice(0, slash);
    const id = name.slice(slash + 1);
    const model = registry.getModel(provider, id);
    if (model) return model;
  } else {
    for (const p of registry.getProviders()) {
      const model = registry.getModel(p.id, name);
      if (model) return model;
    }
  }
  throw new Error(`Model not found in registry: ${name}`);
}
