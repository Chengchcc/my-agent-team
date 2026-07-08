import type { SettingsRow } from "./domain.js";

export interface SettingsPort {
  get(key: string): SettingsRow | undefined;
  set(key: string, value: string): void;
  getAll(): SettingsRow[];
}
