import { existsSync } from 'node:fs';
import os from 'os';
import { Database } from 'bun:sqlite';

/**
 * Configure custom SQLite library for platforms that need it.
 * macOS system SQLite doesn't support dynamic extension loading,
 * so we use Homebrew sqlite3 if available.
 */
export function configureSqlite(): void {
  if (os.platform() !== 'darwin') return;

  const brewSqlitePaths = [
    '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib',
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite3/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
  ];

  for (const p of brewSqlitePaths) {
    if (existsSync(p)) {
      (Database as typeof Database & { setCustomSQLite: (path: string) => void }).setCustomSQLite(p);
      break;
    }
  }
}
