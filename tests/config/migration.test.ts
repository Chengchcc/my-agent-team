import { describe, it, expect } from 'bun:test';
import { runMigrations } from '../../src/config/migrations';
import { CURRENT_CONFIG_VERSION } from '../../src/config/types';

describe('Config migrations', () => {
  it('should return unchanged config when version matches current', () => {
    const config = { version: CURRENT_CONFIG_VERSION } as Record<string, unknown>;
    const result = runMigrations(config, CURRENT_CONFIG_VERSION);
    expect(result.version).toBe(CURRENT_CONFIG_VERSION);
  });

  it('should migrate from version 0 to current version', () => {
    const config = { someKey: 'value' } as Record<string, unknown>;
    const result = runMigrations(config, 0);
    expect(result.version).toBe(CURRENT_CONFIG_VERSION);
    expect(result.someKey).toBe('value');
  });
});
