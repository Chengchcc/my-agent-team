import type { SettingsRow } from "./domain.js";

export interface SettingsPort {
  get(key: string): SettingsRow | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  getAll(): SettingsRow[];
}
