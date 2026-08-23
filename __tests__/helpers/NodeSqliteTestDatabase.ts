import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlRunResult } from '../../src/data/db/SqlDatabase';

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

/**
 * Domain/data code only ever binds strings, numbers, or null (booleans are
 * already converted to 0/1 by the repositories before reaching SqlDatabase
 * — see SqlitePunchRepository). This is a narrowing boundary cast at the
 * test-adapter edge, not a domain-layer `any`: anything outside this set
 * throws immediately rather than being silently miscoerced.
 */
function toSqlInputValue(value: unknown): SqlInputValue {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  throw new Error(`NodeSqliteTestDatabase: unsupported bind value type: ${typeof value}`);
}

/**
 * TEST-ONLY implementation of SqlDatabase, backed by Node's built-in
 * `node:sqlite` — a real, embedded SQLite engine, not a mock. Exists
 * because `expo-sqlite` is a native binding that cannot load in a plain
 * Node/Jest process; this is what lets integration tests exercise the
 * actual production repository, writer, and migration code (src/data/db/*)
 * against a real running database, with real BEGIN/COMMIT/ROLLBACK,
 * inside this sandbox. Nothing outside __tests__ imports this file.
 */
class NodeSqlDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;

  constructor() {
    // `enableForeignKeyConstraints` is node:sqlite's constructor-time
    // equivalent of `PRAGMA foreign_keys = ON` — applied immediately when
    // the connection opens, before any transaction can begin, matching
    // openDatabase.ts's explicit PRAGMA call for ExpoSqlDatabase. The
    // explicit PRAGMA below is redundant with the option but kept so both
    // SqlDatabase implementations are textually and behaviorally
    // equivalent: "foreign keys are on before any migration/transaction
    // runs" isn't left to a single, engine-specific code path.
    this.db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async runAsync(sql: string, params: readonly unknown[] = []): Promise<SqlRunResult> {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params.map(toSqlInputValue));
    return { changes: Number(result.changes) };
  }

  async getFirstAsync<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params.map(toSqlInputValue));
    return (row as T | undefined) ?? null;
  }

  async getAllAsync<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params.map(toSqlInputValue)) as T[];
  }

  /**
   * Real BEGIN/COMMIT/ROLLBACK against the embedded engine. On throw,
   * ROLLBACK runs before the error is rethrown — matching the contract
   * SqlDatabase.withTransactionAsync documents and that expo-sqlite's
   * withTransactionAsync implements natively on-device.
   */
  async withTransactionAsync<T>(work: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function createNodeSqliteTestDatabase(): SqlDatabase {
  return new NodeSqlDatabase();
}
