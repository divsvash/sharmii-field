import type { SqlDatabase } from './SqlDatabase';

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: SqlDatabase) => Promise<void>;
}

/**
 * Applies any migration whose version is greater than the highest version
 * recorded in schema_migrations, in ascending order, each in its own
 * transaction. Safe to call on every app start (process-death recovery
 * relies on this: migrations either fully apply or fully roll back).
 * Engine-agnostic — works against any SqlDatabase implementation.
 */
export async function runMigrations(
  db: SqlDatabase,
  migrations: readonly Migration[],
): Promise<void> {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`,
  );

  const appliedRows = await db.getAllAsync<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC;',
  );
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  const pending = [...migrations]
    .filter((m) => !appliedVersions.has(m.version))
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await db.withTransactionAsync(async () => {
      await migration.up(db);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        [migration.version, new Date().toISOString()],
      );
    });
  }
}
