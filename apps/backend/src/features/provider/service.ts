import { ValidationError } from "../../infra/domain-errors.js";
import type { SettingsService } from "../settings/index.js";
import type {
  CustomKeyInfo,
  ProviderDefinition,
  ProviderInfo,
  StoredProviderConfig,
} from "./domain.js";

/** Providers the UI can configure. Kept separate from the model catalogue
 *  (`@chengchenccc/ai`) because this one carries UI names and the env var
 *  each key comes from; `provider-drift.test.ts` fails if the two lists
 *  disagree, which is how the Z.AI gap was found (the catalogue knew `zai`,
 *  this list did not, so the provider was unreachable in the UI). */
export const KNOWN_PROVIDERS: ProviderDefinition[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
  { id: "openai", name: "OpenAI", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  // GLM Coding Plan: the coding-plan base URL lives in the catalogue entry.
  { id: "zai", name: "Z.AI (GLM)", apiKeyEnv: "ZAI_API_KEY" },
  { id: "groq", name: "Groq", apiKeyEnv: "GROQ_API_KEY" },
  { id: "openrouter", name: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY" },
];

export interface ProviderService {
  list(): ProviderInfo[];
  set(id: string, input: { apiKey?: string; baseUrl?: string }): ProviderInfo;
  clear(id: string): void;
  /** Keys added by name, for providers the builtin list does not know (see
   *  $OMA_HOME/models.yml and its apiKeyEnv). Values never leave the server. */
  listCustomKeys(): CustomKeyInfo[];
  setCustomKey(name: string, value: string): void;
  clearCustomKey(name: string): void;
  getProviderEnv(): Record<string, string | undefined>;
}

const storageKey = (id: string) => `provider.${id}`;

/** One KV row holds every custom key: atomic to update, and the settings read
 *  path masks its values by their own names (they all end in _API_KEY). */
const CUSTOM_ENV_KEY = "providerEnv";

/** A name a provider (or a models.yml entry's apiKeyEnv) would look up. */
export function isProviderKeyName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*_API_KEY$/.test(name);
}

function definitionOf(id: string): ProviderDefinition {
  const def = KNOWN_PROVIDERS.find((d) => d.id === id);
  if (!def) throw new ValidationError(`Unknown provider: ${id}`);
  return def;
}

export function createProviderService(settingsSvc: SettingsService): ProviderService {
  function stored(id: string): StoredProviderConfig {
    return settingsSvc.get<StoredProviderConfig>(storageKey(id)) ?? {};
  }

  function configured(def: ProviderDefinition): boolean {
    const s = stored(def.id);
    return Boolean(s.apiKey || process.env[def.apiKeyEnv]);
  }

  function customEnv(): Record<string, string> {
    const stored = settingsSvc.get<Record<string, string>>(CUSTOM_ENV_KEY);
    if (typeof stored !== "object" || stored === null) return {};
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(stored)) {
      if (typeof value === "string" && value.length > 0) env[name] = value;
    }
    return env;
  }

  return {
    list() {
      return KNOWN_PROVIDERS.map((d) => ({
        id: d.id,
        name: d.name,
        apiKeyEnv: d.apiKeyEnv,
        configured: configured(d),
      }));
    },

    set(id, input) {
      const def = definitionOf(id);
      const current = stored(id);
      const next: StoredProviderConfig = {
        ...current,
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey.trim() } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
      };
      if (!next.apiKey && !next.baseUrl) {
        throw new ValidationError(`Provider ${id} requires an apiKey or baseUrl`);
      }
      settingsSvc.set(storageKey(id), next);
      return {
        id: def.id,
        name: def.name,
        apiKeyEnv: def.apiKeyEnv,
        configured: configured(def),
      };
    },

    clear(id) {
      definitionOf(id);
      settingsSvc.set<StoredProviderConfig>(storageKey(id), {});
    },

    listCustomKeys() {
      return Object.keys(customEnv())
        .sort()
        .map((name) => ({ name, configured: true }));
    },

    setCustomKey(name, value) {
      if (!isProviderKeyName(name)) {
        throw new ValidationError(`expected a name like ZAI_API_KEY, got "${name}"`);
      }
      const trimmed = value.trim();
      if (!trimmed) throw new ValidationError(`provider key ${name} needs a value`);
      settingsSvc.set(CUSTOM_ENV_KEY, { ...customEnv(), [name]: trimmed });
    },

    clearCustomKey(name) {
      const next = customEnv();
      delete next[name];
      settingsSvc.set(CUSTOM_ENV_KEY, next);
    },

    getProviderEnv() {
      const env: Record<string, string | undefined> = {};
      for (const def of KNOWN_PROVIDERS) {
        const s = stored(def.id);
        if (s.apiKey) env[def.apiKeyEnv] = s.apiKey;
        if (s.baseUrl && def.baseUrlEnv) env[def.baseUrlEnv] = s.baseUrl;
      }
      // An explicitly added key wins over a builtin of the same name.
      return { ...env, ...customEnv() };
    },
  };
}
