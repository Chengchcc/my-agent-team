import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the deployment's secrets live. The launcher's `oma gateway` writes it
 *  (login password hash lives here too), so this module must PRESERVE the other
 *  fields it finds - it only owns `mcpEncryptionKey`.
 *
 *  Duplicated from `apps/oh-my-agent/src/core/gateway/artifact.ts` on purpose:
 *  the backend may not import an app, and both must resolve the same path
 *  (`OMA_HOME` or `~/.oma`). */
export function mcpSecretsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.OMA_HOME ?? join(homedir(), ".oma"), "gateway-secrets.json");
}

const KEY_FIELD = "mcpEncryptionKey";
const PREFIX = "enc:v1:";

interface SecretsFile {
  [key: string]: unknown;
}

function readSecrets(path: string): SecretsFile {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as SecretsFile) : {};
  } catch {
    return {};
  }
}

function writeSecrets(path: string, value: SecretsFile): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // The mode argument only applies on creation; a pre-existing file keeps its
  // old bits, so set them explicitly.
  chmodSync(path, 0o600);
}

/** Load the MCP encryption key, generating it on first use.
 *
 *  Kept out of the data directory on purpose (option A of the network-deployment
 *  gate): a copied `dataDir` / `backend.db` then contains ciphertext only. The
 *  file is the launcher's, 0600, and every other field in it is preserved. */
export function loadOrCreateMcpKey(path: string = mcpSecretsFile()): Buffer {
  const secrets = readSecrets(path);
  const existing = secrets[KEY_FIELD];
  if (typeof existing === "string" && existing.length > 0) {
    return Buffer.from(existing, "base64");
  }
  const key = randomBytes(32);
  // Preserve whatever the launcher put here (password hash, gateway tokens...).
  writeSecrets(path, { ...secrets, [KEY_FIELD]: key.toString("base64") });
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/** Decrypt one value. Plaintext (legacy) passes through unchanged so an old
 *  catalog keeps working; the caller re-encrypts it. A value that LOOKS
 *  encrypted but does not decrypt means the key is wrong or the file was
 *  edited by hand - that must fail loudly, not hand the child garbage. */
export function decryptSecret(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value;
  const [ivPart, tagPart, cipherPart] = value.slice(PREFIX.length).split(":");
  if (!ivPart || !tagPart || !cipherPart) {
    throw new Error("mcp secret is malformed: expected enc:v1:<iv>:<tag>:<ciphertext>");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "mcp secret cannot be decrypted: the encryption key changed (check gateway-secrets.json)",
    );
  }
}
