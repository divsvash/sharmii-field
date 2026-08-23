import type { OutboxItem, OutboxStatus } from '../../src/domain/sync/OutboxItem';
import { isSyncable } from '../../src/domain/sync/OutboxItem';
import type { OutboxDispatchStore } from '../../src/domain/sync/OutboxDispatchStore';
import type { SyncError } from '../../src/domain/sync/SyncError';

/**
 * Minimal, genuinely-conditional implementation of OutboxDispatchStore for
 * tests. tryClaim only succeeds if the tracked status is still
 * PENDING/FAILED_RETRYABLE at call time — the same rule a real SQL
 * `UPDATE ... WHERE status IN (...)` would enforce — so tests can prove
 * the dispatcher never sends a transport request after a failed claim.
 */
export class InMemoryOutboxDispatchStore implements OutboxDispatchStore {
  private readonly statuses = new Map<string, OutboxStatus>();
  readonly markSyncedCalls: string[] = [];
  readonly markFailedCalls: Array<{ id: string; error: SyncError; status: OutboxStatus; nextAttemptAt: string | null }> = [];

  constructor(items: readonly OutboxItem[]) {
    for (const item of items) {
      this.statuses.set(item.id, item.status);
    }
  }

  getStatus(id: string): OutboxStatus | undefined {
    return this.statuses.get(id);
  }

  async tryClaim(id: string): Promise<boolean> {
    const current = this.statuses.get(id);
    if (current === undefined || !isSyncable(current)) {
      return false;
    }
    this.statuses.set(id, 'IN_FLIGHT');
    return true;
  }

  async markSynced(id: string): Promise<void> {
    this.statuses.set(id, 'SYNCED');
    this.markSyncedCalls.push(id);
  }

  async markFailed(
    id: string,
    error: SyncError,
    status: Extract<OutboxStatus, 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'>,
    nextAttemptAt: string | null,
  ): Promise<void> {
    this.statuses.set(id, status);
    this.markFailedCalls.push({ id, error, status, nextAttemptAt });
  }
}
