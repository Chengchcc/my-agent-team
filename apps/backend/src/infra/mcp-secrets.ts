import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gatewaySecretsPath, updateGatewaySecrets } from "@chengchenccc/config/node";

/** Where the deployment's secrets live. Shared with `apps/oh-my-agent` via
 *  `@chengchenccc/config` so both processes use the same path, lockfile, and
 *  atomic `0600` temp-file rename (preserving every other field, and failing
 *  loudly instead of wiping a corrupt file). */
export function mcpSecretsFile(env: NodeJS.ProcessEnv = process.env): string {
  return gatewaySecretsPath(env);
}

const KEY_FIELD = "mcpEncryptionKey";
const PREFIX = "enc:v1:";

/** Load the MCP encryption key, generating it on first use.
 *
 *  Kept out of the data directory on purpose (option A of the network-deployment
 *  gate): a copied `dataDir` / `backend.db` then contains ciphertext only. The
 *  file is the launcher's, 0600, and every other field in it is preserved. */
export function loadOrCreateMcpKey(path: string = mcpSecretsFile()): Buffer {
  let resolvedKey: Buffer | undefined;
  updateGatewaySecrets(path, (secrets) => {
    const existing = secrets[KEY_FIELD];
    if (typeof existing === "string" && existing.length > 0) {
      resolvedKey = Buffer.from(existing, "base64");
      return null;
    }
    const key = randomBytes(32);
    resolvedKey = key;
    return { ...secrets, [KEY_FIELD]: key.toString("base64") };
  });
  return resolvedKey!;
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
