import { existsSync, readFileSync } from "node:fs";
import {
  BUILTIN_PROVIDERS,
  createModelRegistry,
  loadProvider,
  type ModelRegistry,
  type ProviderConfig,
} from "@my-agent-team/ai";
import YAML from "yaml";

interface ModelsYaml {
  providers: Record<string, Omit<ProviderConfig, "id" | "apiKeyEnv"> & { apiKey: string }>;
}

/**
 * Load model registry from models.yml, falling back to env-var auto-detection.
 *
 *   1. models.yml exists → parse and register providers with `apiKey` env set
 *   2. No models.yml → auto-detect builtin providers by env var
 */
export function loadModelRegistry(yamlPath?: string): ModelRegistry {
  const registry = createModelRegistry();

  if (yamlPath && existsSync(yamlPath)) {
    let raw: ModelsYaml;
    try {
      raw = YAML.parse(readFileSync(yamlPath, "utf-8")) as ModelsYaml;
    } catch (err) {
      console.error(`[models] failed to parse ${yamlPath}:`, err);
      return registry;
    }
    if (!raw?.providers || typeof raw.providers !== "object") {
      console.error(`[models] ${yamlPath}: missing or invalid "providers" key`);
      return registry;
    }
    for (const [id, cfg] of Object.entries(raw.providers)) {
      if (!cfg?.api) {
        console.warn(`[models] skipping provider "${id}": missing "api" field`);
        continue;
      }
      const provider = loadProvider({
        id,
        api: cfg.api,
        baseUrl: cfg.baseUrl,
        apiKeyEnv: cfg.apiKey,
        models: cfg.models ?? [],
      });
      if (provider) {
        registry.setProvider(provider);
        console.log(`[models] registered provider "${id}" (${cfg.models?.length ?? 0} models)`);
      } else {
        console.warn(`[models] skipping provider "${id}": ${cfg.apiKey} env var not set`);
      }
    }
  } else {
    for (const [, builtin] of Object.entries(BUILTIN_PROVIDERS)) {
      const provider = loadProvider(builtin);
      if (provider) {
        registry.setProvider(provider);
        console.log(`[models] auto-registered provider "${builtin.id}" from env`);
      }
    }
  }

  return registry;
}
