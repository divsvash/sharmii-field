import type { NewOutboxItem, OutboxItem, OutboxStatus } from './OutboxItem';
import type { SyncError } from './SyncError';

export interface OutboxRepository {
  insert(item: NewOutboxItem): Promise<void>;
  getById(id: string): Promise<OutboxItem | null>;
  getByEntityId(entityId: string): Promise<OutboxItem | null>;
  /**
   * Items eligible to attempt now: status PENDING or FAILED_RETRYABLE, and
   * whose dependsOnOutboxId (if any) is already SYNCED. Ordering respects
   * invariants 3 & 4. The sync engine (not built in this phase) is the
   * only intended caller.
   */
  listSyncable(): Promise<readonly OutboxItem[]>;
  listAll(): Promise<readonly OutboxItem[]>;
  markInFlight(id: string): Promise<void>;
  markSynced(id: string): Promise<void>;
  markFailed(
    id: string,
    error: SyncError,
    status: Extract<OutboxStatus, 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'>,
    /**
     * ISO8601 timestamp before which this item must not be re-attempted,
     * or null for no scheduling constraint (always null for
     * FAILED_TERMINAL, since a terminal failure is never retried).
     * Required rather than optional so every call site is explicit about
     * intent instead of silently defaulting.
     */
    nextAttemptAt: string | null,
  ): Promise<void>;
  /**
   * Process-death recovery: any item left IN_FLIGHT is a claim whose
   * outcome is unknown — either the process that claimed it died mid-sync
   * (server response unknown), or it's still being worked on right now by
   * a live, concurrently-running caller. This method cannot see the
   * difference directly; `staleAfterMs` is how the caller tells it apart:
   *
   *  - Omitted, or 0: recover every IN_FLIGHT item unconditionally,
   *    regardless of how recently it was claimed. Correct ONLY at true
   *    process cold-start (see openDatabase.ts) — nothing else could still
   *    legitimately hold a live claim the instant this process starts, so
   *    "IN_FLIGHT right now" can only mean "abandoned by a previous,
   *    now-dead process."
   *  - A positive value: only recover items whose most recent update is at
   *    least that many milliseconds old. Intended for a caller that may
   *    run repeatedly *within* one process's lifetime (SyncEngine.runOnce,
   *    potentially triggered by more than one overlapping caller — a
   *    connectivity listener firing twice, a manual "sync now" tap during
   *    an existing run) — there, an IN_FLIGHT item younger than the
   *    threshold might be a live, still-in-progress attempt by a sibling
   *    call, and reclaiming it would let two callers dispatch the exact
   *    same item concurrently. A stale-enough item is still recovered,
   *    same as before.
   *
   * Idempotency keys make retrying an uncertain request safe even without
   * this threshold — this isn't a correctness backstop against duplicate
   * server-side mutations, it's what prevents an unnecessary *duplicate
   * HTTP request* (and the resulting race between two callers writing the
   * outcome) in the first place. Returns the number of items recovered,
   * for logging/telemetry.
   */
  recoverInFlightItems(staleAfterMs?: number): Promise<number>;
}
