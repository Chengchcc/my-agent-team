import { ValidationError } from "../../infra/domain-errors.js";
import type { SettingsService } from "../settings/index.js";

/** Storage key for the login verifier. The name deliberately matches
 *  `isSecretKey`, so the KV read path masks it and the generic write route
 *  refuses it. */
const PASSWORD_HASH_KEY = "auth.password_hash";

/** Floor for a password typed in the UI; the generator ships 22 characters. */
const MIN_PASSWORD_LENGTH = 8;

export interface PasswordService {
  /** Store an argon2id verifier for the new password. The plaintext is never
   *  persisted — only a hash, which is what a login needs. */
  set(plain: string): Promise<void>;
  /** `undefined` when nothing has been set here yet: the caller then falls back
   *  to its own configured password (the launcher's secret / env). */
  verify(plain: string): Promise<boolean | undefined>;
  /** Whether a UI-set password exists (status surfaces read this). */
  isSet(): boolean;
}

export function createPasswordService(settingsSvc: SettingsService): PasswordService {
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
  };
}
