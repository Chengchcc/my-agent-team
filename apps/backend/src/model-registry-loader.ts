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
    const raw = YAML.parse(readFileSync(yamlPath, "utf-8")) as ModelsYaml;
    for (const [id, cfg] of Object.entries(raw.providers)) {
      const provider = loadProvider({
        id,
        api: cfg.api,
        baseUrl: cfg.baseUrl,
        apiKeyEnv: cfg.apiKey,
        models: cfg.models,
      });
      if (provider) registry.setProvider(provider);
    }
  } else {
    for (const [, builtin] of Object.entries(BUILTIN_PROVIDERS)) {
      const provider = loadProvider(builtin);
      if (provider) registry.setProvider(provider);
    }
  }

  return registry;
}
