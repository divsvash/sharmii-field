import type { OutboxStatus } from './OutboxItem';
import type { SyncError } from './SyncError';

/**
 * The smallest persistence capability OutboxDispatcher needs — a subset
 * of OutboxRepository's responsibilities, not a replacement for it.
 * OutboxRepository also owns insert/list/recovery concerns the dispatcher
 * has no business touching; depending on the full interface here would
 * let a dispatch bug reach into unrelated outbox state. Any concrete
 * repository that already implements OutboxRepository's markSynced/
 * markFailed satisfies those two methods here for free; only tryClaim is
 * new.
 *
 * No UnitOfWork, transaction framework, event bus, or command bus: three
 * narrow methods, each one write.
 */
export interface OutboxDispatchStore {
  /**
   * Atomically transitions the item from PENDING or FAILED_RETRYABLE to
   * IN_FLIGHT, but ONLY if it is still in one of those states at the
   * moment of the call. Returns true iff this call performed the
   * transition — false means someone else already claimed it (or it
   * isn't in a claimable state), and the caller must not send anything.
   *
   * This is the concurrency-safety boundary: "blindly" setting IN_FLIGHT
   * without checking prior state would let two workers both believe they
   * own the same item. A correct SQL implementation is a single
   * conditional UPDATE (`WHERE id = ? AND status IN ('PENDING',
   * 'FAILED_RETRYABLE')`), checking the affected-row count.
   */
  tryClaim(id: string): Promise<boolean>;

  /** Marks a successfully-claimed item as durably accepted by the server. */
  markSynced(id: string): Promise<void>;

  /** Marks a successfully-claimed item as failed, with the given classified error, resulting status, and (for FAILED_RETRYABLE only) the next-eligible-attempt time computed by RetryPolicy. Null for FAILED_TERMINAL. */
  markFailed(
    id: string,
    error: SyncError,
    status: Extract<OutboxStatus, 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'>,
    nextAttemptAt: string | null,
  ): Promise<void>;
}
