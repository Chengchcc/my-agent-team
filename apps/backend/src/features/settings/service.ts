import type { BackendConfig } from "../../config.js";
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  loadOrCreateMcpKey,
} from "../../infra/mcp-secrets.js";
import type { SettingsRow } from "./domain.js";
import type { SettingsPort } from "./ports.js";

export interface SystemInfo {
  env: Record<string, string>;
  paths: Record<string, string>;
}

export interface SettingsService {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  getAll(): Record<string, unknown>;
  getSystemInfo(): SystemInfo;
}

function maskSecret(v: string): string {
  return v.length > 4 ? `****${v.slice(-4)}` : "****";
}

export function isSecretKey(k: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(k);
}

/** Mask secret-shaped values before they leave the service (H5): a key
 *  matching isSecretKey masks its string value; object values recurse so
 *  `provider.<id>.apiKey` is masked without masking `baseUrl`. */
function maskDeep(k: string, v: unknown): unknown {
  if (typeof v === "string" && isSecretKey(k)) return maskSecret(v);
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v).map(([k2, v2]) => [k2, maskDeep(k2, v2)]));
  }
  return v;
}

/** Seal secret-shaped strings before they reach the database (H5's other
 *  half): masking keeps them out of a response, this keeps them out of a
 *  copied backend.db. Same AES-256-GCM key the MCP catalog uses - the key
 *  lives outside the data directory, so ciphertext alone buys nothing. */
function sealDeep(secretKey: Buffer, k: string, v: unknown): unknown {
  if (typeof v === "string" && v.length > 0 && isSecretKey(k) && !isEncrypted(v)) {
    return encryptSecret(v, secretKey);
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return Object.fromEntries(
      Object.entries(v).map(([k2, v2]) => [k2, sealDeep(secretKey, k2, v2)]),
    );
  }
  return v;
}

/** Open the sealed strings on the way out. `needsSeal` reports a legacy
 *  plaintext secret so `get` can re-seal it on the same read - the same
 *  one-way migration the MCP catalog does. */
function openDeep(
  secretKey: Buffer,
  k: string,
  v: unknown,
): { value: unknown; needsSeal: boolean } {
  if (typeof v === "string" && isSecretKey(k) && v.length > 0) {
    if (isEncrypted(v)) return { value: decryptSecret(v, secretKey), needsSeal: false };
    return { value: v, needsSeal: true };
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const opened = Object.entries(v).map(([k2, v2]) => [k2, openDeep(secretKey, k2, v2)] as const);
    return {
      value: Object.fromEntries(opened.map(([k2, o]) => [k2, o.value])),
      needsSeal: opened.some(([, o]) => o.needsSeal),
    };
  }
  return { value: v, needsSeal: false };
}

export function createSettingsService(deps: {
  port: SettingsPort;
  config: BackendConfig;
  /** Tests inject a fixed key; production resolves the deployment's one from
   *  gateway-secrets.json on first use (never in the data dir). */
  secretKey?: Buffer;
}): SettingsService {
  const { port, config } = deps;
  let cachedKey: Buffer | undefined = deps.secretKey;
  const secretKey = (): Buffer => (cachedKey ??= loadOrCreateMcpKey());

  return {
    get<T>(key: string): T | undefined {
      const row = port.get(key);
      if (!row) return undefined;
      // Parse failures are "not configured"; decrypt failures are NOT - a key
      // mismatch must look broken, not empty, or a provider silently loses
      // its credentials and the next run fails with "no api key".
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        return undefined;
      }
      const opened = openDeep(secretKey(), key, parsed);
      if (opened.needsSeal) {
        port.set(key, JSON.stringify(sealDeep(secretKey(), key, opened.value)));
      }
      return opened.value as T;
    },

    set<T>(key: string, value: T): void {
      port.set(key, JSON.stringify(sealDeep(secretKey(), key, value)));
    },

    delete(key: string): void {
      port.delete(key);
    },

    getAll(): Record<string, unknown> {
      const rows: SettingsRow[] = port.getAll();
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value);
        } catch {
          continue;
        }
        // Decrypt failures propagate on purpose: an unreadable secret means a
        // wrong key, and showing an empty settings page would hide that.
        const opened = openDeep(secretKey(), row.key, parsed);
        result[row.key] = maskDeep(row.key, opened.value);
      }
      return result;
    },

    getSystemInfo(): SystemInfo {
      const env = process.env;
      const envOut: Record<string, string> = {};
      const envKeys = [
        "BACKEND_HOST",
        "BACKEND_PORT",
        "BACKEND_DATA_DIR",
        "BACKEND_WORKSPACE_ROOT",
        "BACKEND_TEMPLATE_DIR",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "GROQ_API_KEY",
        "OPENROUTER_API_KEY",
        "NODE_ENV",
        "RUNNER_ENV",
      ];
      for (const k of envKeys) {
        const v = env[k];
        if (v === undefined) continue;
        envOut[k] = isSecretKey(k) ? maskSecret(v) : v;
      }

      return {
        env: envOut,
        paths: {
          dataDir: config.dataDir,
          workspaceRoot: config.workspaceRoot,
          agentWorkspace: `${config.dataDir}/agents/:id`,
          skillPacks: `${config.dataDir}/skill-packs`,
          backendDb: `${config.dataDir}/backend.db`,
          builtinSkills: config.builtinSkillsDir,
        },
      };
    },
  };
}
