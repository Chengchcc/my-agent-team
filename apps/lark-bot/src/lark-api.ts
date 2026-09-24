import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Tenant-access-token provider for the Lark hot path (ADR 0031).
 *
 * lark-cli owns the app credentials: it stores them encrypted under
 * ~/.local/share/lark-cli/appsecret_<appId>.enc with a sibling master.key
 * (AES-256-GCM, 12-byte nonce prefix + 16-byte tag). Same user, same box —
 * we recover the secret of OUR app from OUR machine instead of asking the
 * operator to re-paste it, mint a tenant token via the internal endpoint
 * and cache it until shortly before expiry. lark-cli stays the source of
 * truth for profiles; this module only reads its store.
 */

const FEISHU_BASE = "https://open.feishu.cn";
const LARK_BASE = "https://open.larksuite.com";

interface LarkCliConfig {
  apps?: Array<{ name: string; appId: string; brand?: string }>;
}

function cliConfigPath(): string {
  return join(homedir(), ".lark-cli", "config.json");
}

function secretStoreDir(): string {
  return join(homedir(), ".local", "share", "lark-cli");
}

/** Decrypt one appsecret blob: nonce(12) || ciphertext || tag(16). */
export function decryptAppSecret(blob: Buffer, masterKey: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export interface TokenProvider {
  /** Resolves a cached-or-fresh tenant token; single-flight. */
  getToken(): Promise<string>;
  /** Drop the cache (called after a 401-class rejection). */
  invalidate(): void;
  /** The brand-specific Open API base (feishu vs lark). */
  getBaseUrl(): string;
}

export function createTokenProvider(profile: string): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  function resolveApp(): { appId: string; baseUrl: string } {
    const cfgPath = cliConfigPath();
    if (!existsSync(cfgPath)) {
      throw new Error(`lark-cli config not found at ${cfgPath}`);
    }
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as LarkCliConfig;
    const app = (cfg.apps ?? []).find((a) => a.name === profile);
    if (!app) throw new Error(`profile "${profile}" not found in lark-cli config`);
    return { appId: app.appId, baseUrl: app.brand === "lark" ? LARK_BASE : FEISHU_BASE };
  }

  function readSecret(appId: string): string {
    const dir = secretStoreDir();
    const keyPath = join(dir, "master.key");
    const encPath = join(dir, `appsecret_${appId}.enc`);
    const keyPresent = existsSync(keyPath);
    const encPresent = existsSync(encPath);
    const storeIncomplete = !keyPresent || !encPresent;
    if (storeIncomplete) {
      throw new Error(`lark-cli secret store incomplete for ${appId} (looked in ${dir})`);
    }
    return decryptAppSecret(readFileSync(encPath), readFileSync(keyPath));
  }
  async function mint(): Promise<string> {
    const { appId, baseUrl } = resolveApp();
    const resp = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: readSecret(appId) }),
    });
    if (!resp.ok) throw new Error(`tenant token endpoint HTTP ${resp.status}`);
    const body: { code?: number; msg?: string; tenant_access_token?: string; expire?: number } =
      await resp.json();
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`tenant token mint failed: code ${body.code} ${body.msg ?? ""}`);
    }
    const ttlMs = (body.expire ?? 3600) * 1000;
    cached = { token: body.tenant_access_token, expiresAt: Date.now() + ttlMs - 5 * 60_000 };
    return cached.token;
  }

  return {
    async getToken(): Promise<string> {
      if (cached && Date.now() < cached.expiresAt) return cached.token;
      if (inflight) return inflight;
      inflight = mint().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate(): void {
      cached = null;
    },
    getBaseUrl(): string {
      return resolveApp().baseUrl;
    },
  };
}
