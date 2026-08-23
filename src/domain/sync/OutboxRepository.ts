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
   * Process-death recovery: any item left IN_FLIGHT (the app died mid-sync,
   * so whether the server received the request is unknown) is moved to
   * FAILED_RETRYABLE. This is safe — not merely convenient — because every
   * outbox item carries an idempotency key: retrying an uncertain request
   * cannot double-apply it server-side. Must be called once at startup,
   * before any new sync attempts begin. Returns the number of items
   * recovered, for logging/telemetry.
   */
  recoverInFlightItems(): Promise<number>;
}
