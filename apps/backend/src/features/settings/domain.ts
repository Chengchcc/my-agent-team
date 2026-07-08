/** Settings - runtime-tunable key-value config.
 *  Any feature can register a key (convention: `domain.fieldName`) and
 *  read it via `settings.get<T>(key) ?? defaultValue`. No schema change
 *  needed to add new parameters. */
export interface SettingsRow {
  key: string;
  /** JSON-serialized value */
  value: string;
  updatedAt: number;
}
