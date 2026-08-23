/**
 * Infrastructure-layer port (data/db, NOT domain) abstracting over the
 * concrete SQLite engine. Two implementations exist:
 *
 *  - ExpoSqlDatabase  — production, wraps `expo-sqlite` (React Native).
 *  - NodeSqlDatabase  — test-only, wraps Node's built-in `node:sqlite`.
 *
 * Why this exists: the assignment requires proving, with a real running
 * transaction (not a type-level claim), that createPunch + createOutboxItem
 * commit atomically or not at all — including a deterministic rollback
 * test. `expo-sqlite` is a native binding with no pure-JS/Node
 * implementation, so it cannot execute inside this Node-only sandbox (no
 * Android/iOS runtime is available here). Node 22 ships a built-in,
 * real, embedded SQLite engine (`node:sqlite`) that speaks the same SQL
 * dialect and the same transaction semantics. Structuring migrations,
 * repositories, and AtomicOutboxWriter against this interface — rather
 * than the concrete `SQLiteDatabase` type from `expo-sqlite` — lets the
 * exact same SQL and transaction-boundary code run for real against
 * `node:sqlite` in tests, and against `expo-sqlite` on-device in
 * production. This is not a speculative abstraction: it is the mechanism
 * that makes the rollback test possible at all, and it is also the
 * concrete fulfillment of invariant 9 (persistence engine is replaceable)
 * — we are not just claiming replaceability, we are using it.
 */
export interface SqlRunResult {
  readonly changes: number;
}

export interface SqlDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: readonly unknown[]): Promise<SqlRunResult>;
  getFirstAsync<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Runs `work` inside BEGIN/COMMIT. If `work` throws, the implementation
   * must ROLLBACK and rethrow. Every statement issued by `work` (directly,
   * or indirectly via repositories constructed on this same SqlDatabase)
   * participates in the same transaction.
   */
  withTransactionAsync<T>(work: () => Promise<T>): Promise<T>;
}
