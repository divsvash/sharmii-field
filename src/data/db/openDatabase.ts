import * as SQLite from 'expo-sqlite';
import { ExpoSqlDatabase } from './ExpoSqlDatabase';
import { runMigrations } from './Migration';
import { migrations } from './migrations';
import type { SqlDatabase } from './SqlDatabase';
import { SqliteOutboxRepository } from './SqliteOutboxRepository';

const DATABASE_NAME = 'shramii_field.db';

/**
 * Single entrypoint for obtaining a ready-to-use database handle:
 * opens (or creates) the file, enables foreign-key enforcement, applies
 * any pending migrations, then runs process-death recovery (any outbox
 * item left IN_FLIGHT by a previous, un-clean process exit is moved to
 * FAILED_RETRYABLE — see OutboxRepository.recoverInFlightItems). Safe to
 * call again after a process death — enabling foreign keys, migrations,
 * and recovery are all idempotent.
 */
export async function openDatabase(): Promise<SqlDatabase> {
  const native = await SQLite.openDatabaseAsync(DATABASE_NAME);
  const db: SqlDatabase = new ExpoSqlDatabase(native);

  // Must run before any transaction begins: SQLite treats
  // `PRAGMA foreign_keys` as a no-op when issued inside a transaction, and
  // runMigrations wraps every migration's `up()` in one. Doing it here,
  // right after opening the connection, is the only point that reliably
  // applies for the lifetime of this connection.
  await db.execAsync('PRAGMA foreign_keys = ON;');

  await runMigrations(db, migrations);

  const outboxRepo = new SqliteOutboxRepository(db);
  const recoveredCount = await outboxRepo.recoverInFlightItems();
  if (recoveredCount > 0) {
    // eslint-disable-next-line no-console -- deliberate startup diagnostic, not a logging framework decision
    console.warn(
      `[shramii] Recovered ${recoveredCount} outbox item(s) left IN_FLIGHT by a previous process death.`,
    );
  }

  return db;
}
