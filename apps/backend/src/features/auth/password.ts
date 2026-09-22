import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../../infra/domain-errors.js";
import type { SettingsService } from "../settings/index.js";

/** Storage key for the login verifier. The name deliberately matches
 *  `isSecretKey`, so the KV read path masks it and the generic write route
 *  refuses it. */
export const PASSWORD_HASH_KEY = "auth.password_hash";

/** Operator-requested reset marker, relative to the data dir. Whoever owns the
 *  deployment (a human, `oma gateway passwd`, scripts/reset-login-password.sh)
 *  drops this file to ask for the stored password to be dropped, and only the
 *  backend acts on it — so the database keeps exactly one writer. */
export const PASSWORD_RESET_MARKER = "password-reset";

/** Floor for a password typed in the UI; the generator ships 22 characters. */
export const MIN_PASSWORD_LENGTH = 8;

export interface PasswordService {
  /** Store an argon2id verifier for the new password. The plaintext is never
   *  persisted — only a hash, which is what a login needs. */
  set(plain: string): Promise<void>;
  /** `undefined` when nothing has been set here yet: the caller then falls back
   *  to its own configured password (the launcher's secret / env). */
  verify(plain: string): Promise<boolean | undefined>;
  /** Whether a UI-set password exists (status surfaces read this). */
  isSet(): boolean;
  /** Adopt the launcher's password as this stack's password, ONCE.
   *
   *  The env/secret password is a bootstrap credential: it exists so a fresh
   *  install is loginable before anyone has set one, and it is regenerated per
   *  checkout (gitignored `.env`, per-machine gateway secrets). Keeping it as a
   *  live fallback means the login password silently changes whenever a
   *  launcher or a fresh clone regenerates it. Seeding the hash on first boot
   *  makes the database the single source of truth from then on.
   *
   *  Returns what happened: `already-set` (a password exists, nothing touched),
   *  `seeded` (this call wrote the hash), `too-short` (bootstrap present but
   *  below the floor), or `none` (no bootstrap password configured). */
  seedFromBootstrap(
    plain: string | undefined,
  ): Promise<"already-set" | "seeded" | "too-short" | "none" | "reset">;
}

export function createPasswordService(
  settingsSvc: SettingsService,
  opts: { dataDir?: string } = {},
): PasswordService {
  function storedHash(): string | undefined {
    const value = settingsSvc.get<string>(PASSWORD_HASH_KEY);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  return {
    async set(plain: string): Promise<void> {
      if (plain.length < MIN_PASSWORD_LENGTH) {
        throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      settingsSvc.set(PASSWORD_HASH_KEY, await Bun.password.hash(plain));
    },

    async verify(plain: string): Promise<boolean | undefined> {
      const hash = storedHash();
      if (!hash) return undefined;
      return await Bun.password.verify(plain, hash);
    },

    isSet(): boolean {
      return storedHash() !== undefined;
    },

    async seedFromBootstrap(plain) {
      // An operator's reset request outranks the stored hash: honour it before
      // anything else, then let the bootstrap value take over (or leave nothing
      // stored, so the caller's fallback window applies again).
      const reset = opts.dataDir !== undefined && consumeResetMarker(opts.dataDir);
      if (reset) settingsSvc.delete(PASSWORD_HASH_KEY);
      if (reset && !plain) return "reset";
      if (!reset && storedHash() !== undefined) return "already-set";
      if (!plain) return "none";
      if (plain.length < MIN_PASSWORD_LENGTH) return "too-short";
      settingsSvc.set(PASSWORD_HASH_KEY, await Bun.password.hash(plain));
      return "seeded";
    },
  };
}

/** Consume the operator's reset marker: delete it and report whether it was
 *  there. Deleting eagerly is deliberate — a marker that survived would drop
 *  the password again on every boot. */
function consumeResetMarker(dataDir: string): boolean {
  const marker = join(dataDir, PASSWORD_RESET_MARKER);
  if (!existsSync(marker)) return false;
  rmSync(marker, { force: true });
  return true;
}
