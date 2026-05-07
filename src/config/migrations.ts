import { CURRENT_CONFIG_VERSION } from './types';

export interface ConfigMigration {
  from: number;
  to: number;
  migrate(config: Record<string, unknown>): Record<string, unknown>;
}

const MIGRATIONS: ConfigMigration[] = [
  {
    from: 0,
    to: 1,
    migrate(config: Record<string, unknown>): Record<string, unknown> {
      return { ...config, version: 1 };
    },
  },
];

export function runMigrations(
  config: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> {
  let result = { ...config };
  let currentVersion = fromVersion;

  while (currentVersion < CURRENT_CONFIG_VERSION) {
    const migration = MIGRATIONS.find(m => m.from === currentVersion);
    if (!migration) break;
    result = migration.migrate(result);
    currentVersion = migration.to;
  }

  return { ...result, version: CURRENT_CONFIG_VERSION };
}
