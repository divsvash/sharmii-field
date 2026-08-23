import { isSyncable, type OutboxItem, type OutboxStatus } from '../../src/domain/sync/OutboxItem';
import type { OutboxDispatchStore } from '../../src/domain/sync/OutboxDispatchStore';
import type { OutboxSnapshotSource } from '../../src/domain/sync/SyncEngine';
import type { SyncError } from '../../src/domain/sync/SyncError';

/**
 * A single fake implementing both narrow interfaces SyncEngine depends
 * on, backed by one shared map — exactly mirroring how, in production,
 * SqliteOutboxRepository and SqliteOutboxDispatchStore are two classes
 * over the same underlying SqlDatabase. Using two independently-stateful
 * fakes here would risk them drifting out of sync with each other in a
 * way that has nothing to do with the engine being tested.
 */
export class InMemoryOutboxStore implements OutboxSnapshotSource, OutboxDispatchStore {
  private readonly items = new Map<string, OutboxItem>();

  constructor(items: readonly OutboxItem[] = []) {
    for (const item of items) {
      this.items.set(item.id, item);
    }
  }

  getStatus(id: string): OutboxStatus | undefined {
    return this.items.get(id)?.status;
  }

  async recoverInFlightItems(): Promise<number> {
    const now = new Date().toISOString();
    let recovered = 0;

    for (const [id, item] of this.items) {
      if (item.status === 'IN_FLIGHT') {
        this.items.set(id, {
          ...item,
          status: 'FAILED_RETRYABLE',
          lastError: {
            kind: 'retryable',
            reason: 'PROCESS_INTERRUPTED',
            message: 'Recovered after process death; previous attempt outcome unknown',
            occurredAt: now,
          },
          nextAttemptAt: null,
          updatedAt: now,
        });
        recovered += 1;
      }
    }

    return recovered;
  }

  async listAll(): Promise<readonly OutboxItem[]> {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async tryClaim(id: string): Promise<boolean> {
    const item = this.items.get(id);
    if (!item || !isSyncable(item.status)) {
      return false;
    }
    this.items.set(id, { ...item, status: 'IN_FLIGHT', updatedAt: new Date().toISOString() });
    return true;
  }

  async markSynced(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`InMemoryOutboxStore: no item ${id}`);
    this.items.set(id, { ...item, status: 'SYNCED', updatedAt: new Date().toISOString() });
  }

  async markFailed(
    id: string,
    error: SyncError,
    status: Extract<OutboxStatus, 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'>,
    nextAttemptAt: string | null,
  ): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`InMemoryOutboxStore: no item ${id}`);
    this.items.set(id, {
      ...item,
      status,
      attempts: item.attempts + 1,
      lastError: error,
      nextAttemptAt,
      updatedAt: new Date().toISOString(),
    });
  }
}
