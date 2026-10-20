import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  loadOrCreateMcpKey,
} from "../../infra/mcp-secrets.js";
import type { McpServerRow } from "./domain.js";
import type { CreateMcpServerRecord, McpServerPort, UpdateMcpServerRecord } from "./ports.js";

/** File-backed catalog (ADR 0022): server definitions live in
 *  <dataDir>/mcp-servers.json — deployment-level config, human-editable,
 *  like models.yml. No DB table. Writes are synchronous whole-file
 *  rewrites (the catalog is tiny; ponytail: no locking beyond the
 *  process). */

export interface FileEntry {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  url: string | null;
  createdAt: number;
  updatedAt: number;
}

export function mcpCatalogPath(dataDir: string): string {
  return join(dataDir, "mcp-servers.json");
}

/** One key per process; the file is the launcher's (0600, outside dataDir). */
let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  cachedKey ??= loadOrCreateMcpKey();
  return cachedKey;
}

function mapValues(
  record: Record<string, string>,
  fn: (value: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) out[name] = fn(value);
  return out;
}

export function readMcpCatalog(dataDir: string): FileEntry[] {
  const path = mcpCatalogPath(dataDir);
  if (!existsSync(path)) return [];
  let servers: FileEntry[];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { servers?: FileEntry[] };
    servers = parsed.servers ?? [];
  } catch {
    return [];
  }
  const key = encryptionKey();
  let sawPlaintext = false;
  const decrypted = servers.map((entry) => {
    for (const value of [
      ...Object.values(entry.env ?? {}),
      ...Object.values(entry.headers ?? {}),
    ]) {
      if (!isEncrypted(value)) sawPlaintext = true;
    }
    return {
      ...entry,
      env: mapValues(entry.env ?? {}, (value) => decryptSecret(value, key)),
      headers: mapValues(entry.headers ?? {}, (value) => decryptSecret(value, key)),
    };
  });
  // Legacy catalogs (and hand edits) are plaintext: re-encrypt the file the
  // first time it is read, so a copied dataDir stops carrying live secrets
  // immediately rather than at the next edit.
  if (sawPlaintext) writeMcpCatalog(dataDir, decrypted);
  return decrypted;
}

/** At rest, every env/header value is ciphertext. The catalog stays
 *  human-editable - a plaintext value written by hand is simply re-encrypted on
 *  the next read. The key lives in the launcher's gateway-secrets.json, so a
 *  copied dataDir (or backend.db) contains nothing usable. */
function writeMcpCatalog(dataDir: string, servers: FileEntry[]): void {
  const key = encryptionKey();
  const sealed = servers.map((entry) => ({
    ...entry,
    env: mapValues(entry.env ?? {}, (value) => encryptSecret(value, key)),
    headers: mapValues(entry.headers ?? {}, (value) => encryptSecret(value, key)),
  }));
  writeFileSync(mcpCatalogPath(dataDir), `${JSON.stringify({ servers: sealed }, null, 2)}\n`);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  try {
    return JSON.parse(raw ?? "") as T;
  } catch {
    return fallback;
  }
}

export function fileMcpServerAdapter(dataDir: string): McpServerPort {
  const rows = (): McpServerRow[] =>
    readMcpCatalog(dataDir).map((e) => ({
      serverId: e.serverId,
      name: e.name,
      transport: e.transport,
      command: e.command,
      args: e.args,
      env: e.env,
      headers: e.headers,
      url: e.url,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));

  return {
    create(input: CreateMcpServerRecord): McpServerRow {
      const servers = readMcpCatalog(dataDir);
      servers.push({
        serverId: input.serverId,
        name: input.name,
        transport: input.transport as "stdio" | "sse",
        command: input.command,
        args: parseJson(input.args, [] as string[]),
        env: parseJson(input.env, {} as Record<string, string>),
        headers: parseJson(input.headers, {} as Record<string, string>),
        url: input.url,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      writeMcpCatalog(dataDir, servers);
      return rows().find((r) => r.serverId === input.serverId)!;
    },

    list(): McpServerRow[] {
      return rows();
    },

    getById(serverId: string): McpServerRow | null {
      return rows().find((r) => r.serverId === serverId) ?? null;
    },

    update(serverId: string, patch: UpdateMcpServerRecord): McpServerRow | null {
      const servers = readMcpCatalog(dataDir);
      const idx = servers.findIndex((e) => e.serverId === serverId);
      if (idx < 0) return null;
      const entry = servers[idx]!;
      const next: FileEntry = { ...entry, updatedAt: patch.updatedAt };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.command !== undefined) next.command = patch.command;
      if (patch.args !== undefined) next.args = parseJson(patch.args, [] as string[]);
      if (patch.env !== undefined) next.env = parseJson(patch.env, {} as Record<string, string>);
      if (patch.headers !== undefined) {
        next.headers = parseJson(patch.headers, {} as Record<string, string>);
      }
      if (patch.url !== undefined) next.url = patch.url;
      servers[idx] = next;
      writeMcpCatalog(dataDir, servers);
      return rows().find((r) => r.serverId === serverId) ?? null;
    },

    delete(serverId: string): boolean {
      const servers = readMcpCatalog(dataDir);
      const next = servers.filter((e) => e.serverId !== serverId);
      if (next.length === servers.length) return false;
      writeMcpCatalog(dataDir, next);
      return true;
    },
  };
}
