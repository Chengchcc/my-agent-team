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
  // Guard: strip accidental leading "/" from empty provider
  const clean = name.startsWith("/") ? name.slice(1) : name;
  const slash = clean.indexOf("/");
  if (slash > 0) {
    const provider = clean.slice(0, slash);
    const id = clean.slice(slash + 1);
    const model = registry.getModel(provider, id);
    if (model) return model;
  } else {
    for (const p of registry.getProviders()) {
      const model = registry.getModel(p.id, clean);
      if (model) return model;
    }
  }
  throw new Error(`Model not found in registry: ${name}`);
}
