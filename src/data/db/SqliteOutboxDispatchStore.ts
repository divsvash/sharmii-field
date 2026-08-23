import type { SqlDatabase } from './SqlDatabase';
import type { OutboxDispatchStore } from '../../domain/sync/OutboxDispatchStore';
import type { OutboxStatus } from '../../domain/sync/OutboxItem';
import { serializeSyncError, type SyncError } from '../../domain/sync/SyncError';

/**
 * Concrete SQLite implementation of the dispatcher's narrow persistence
 * boundary. Deliberately self-contained — it does NOT depend on or wrap
 * SqliteOutboxRepository, even though markSynced/markFailed here duplicate
 * a few lines of SQL also found there. Depending on the full repository
 * would defeat the point of OutboxDispatchStore being narrow: a dispatch
 * bug should not be able to reach insert/list/recovery concerns just
 * because they happen to live on the same class. The duplication is a few
 * lines of UPDATE statements, not meaningful logic.
 */
export class SqliteOutboxDispatchStore implements OutboxDispatchStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Atomic conditional claim. This is a SINGLE UPDATE with the eligibility
   * check in its WHERE clause — not a SELECT-then-UPDATE from TypeScript,
   * which would race two callers both reading "claimable" before either
   * writes. SQLite executes one UPDATE statement as a single atomic
   * operation against the row (this holds even outside an explicit
   * BEGIN/COMMIT — a single statement is always atomic in SQLite), so the
   * database itself — not application code — performs the conditional
   * state transition:
   *
   *   UPDATE outbox_items
   *   SET status = 'IN_FLIGHT', updated_at = ?
   *   WHERE id = ?
   *     AND status IN ('PENDING', 'FAILED_RETRYABLE');
   *
   * `result.changes` distinguishes the two outcomes: 1 means this call
   * performed the transition (the row existed and was still claimable at
   * the moment SQLite evaluated the WHERE clause); 0 means it didn't
   * (row missing, already IN_FLIGHT, SYNCED, or FAILED_TERMINAL) — no
   * further UPDATE, and by extension no transport call, follows either way.
   */
  async tryClaim(id: string): Promise<boolean> {
    const result = await this.db.runAsync(
      `UPDATE outbox_items
       SET status = 'IN_FLIGHT', updated_at = ?
       WHERE id = ?
         AND status IN ('PENDING', 'FAILED_RETRYABLE');`,
      [new Date().toISOString(), id],
    );

    return result.changes === 1;
  }

  /** Marks a successfully-claimed item as durably accepted by the server. No new status is introduced — SYNCED already exists on OutboxStatus. */
  async markSynced(id: string): Promise<void> {
    await this.db.runAsync(
      `UPDATE outbox_items SET status = 'SYNCED', updated_at = ? WHERE id = ?;`,
      [new Date().toISOString(), id],
    );
  }

  /** Records a classified failure, preserving the existing FAILED_RETRYABLE / FAILED_TERMINAL distinction — no third persisted failure state. Persists nextAttemptAt (null for terminal) for retry scheduling. */
  async markFailed(
    id: string,
    error: SyncError,
    status: Extract<OutboxStatus, 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'>,
    nextAttemptAt: string | null,
  ): Promise<void> {
    await this.db.runAsync(
      `UPDATE outbox_items
       SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE id = ?;`,
      [status, serializeSyncError(error), nextAttemptAt, new Date().toISOString(), id],
    );
  }
}
