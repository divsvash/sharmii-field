import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite';
import type { SqlDatabase, SqlRunResult } from './SqlDatabase';

/**
 * Our repositories only ever bind string, number, boolean (as 0/1), or
 * null values. This narrows `unknown` to what expo-sqlite's bind API
 * accepts, failing loudly on anything unexpected rather than casting
 * past the type checker.
 */
function toBindValue(value: unknown): SQLiteBindValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new Error(`ExpoSqlDatabase: unsupported bind value type: ${typeof value}`);
}

/**
 * Thin passthrough to expo-sqlite's async API — the production
 * implementation of SqlDatabase. expo-sqlite's own method signatures
 * already match SqlDatabase almost exactly; this class exists so nothing
 * outside this one file imports the `expo-sqlite` module directly.
 */
export class ExpoSqlDatabase implements SqlDatabase {
  constructor(private readonly db: SQLiteDatabase) {}

  async execAsync(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async runAsync(sql: string, params: readonly unknown[] = []): Promise<SqlRunResult> {
    const result = await this.db.runAsync(sql, params.map(toBindValue));
    return { changes: result.changes };
  }

  async getFirstAsync<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const row = await this.db.getFirstAsync<T>(sql, params.map(toBindValue));
    return row ?? null;
  }

  async getAllAsync<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params.map(toBindValue));
  }

  async withTransactionAsync<T>(work: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    let assigned = false;

    await this.db.withTransactionAsync(async () => {
      result = await work();
      assigned = true;
    });

    if (!assigned) {
      // withTransactionAsync only resolves after the callback resolves,
      // so this indicates a library contract violation, not a reachable
      // app state.
      throw new Error('ExpoSqlDatabase: transaction resolved without a result');
    }

    return result as T;
  }
}
