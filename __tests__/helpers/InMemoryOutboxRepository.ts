import type {
  NewOutboxItem,
  OutboxItem,
  OutboxStatus,
} from '../../src/domain/sync/OutboxItem';
import type { OutboxRepository } from '../../src/domain/sync/OutboxRepository';
import type { SyncError } from '../../src/domain/sync/SyncError';

/**
 * In-memory implementation of the same OutboxRepository interface the
 * SQLite adapter implements. Its existence — and the fact that
 * OutboxRepository.contract.test.ts runs identical behavioral assertions
 * against both — is the concrete proof of invariants 8 and 9: domain
 * behavior is defined by the interface, not by any one persistence engine.
 */
export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly items = new Map<string, OutboxItem>();

  async insert(item: NewOutboxItem): Promise<void> {
    const now = new Date().toISOString();
    this.items.set(item.id, {
      ...item,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now,
    });
  }

  async getById(id: string): Promise<OutboxItem | null> {
    return this.items.get(id) ?? null;
  }

  async getByEntityId(entityId: string): Promise<OutboxItem | null> {
    for (const item of this.items.values()) {
      if (item.entityId === entityId) return item;
    }
    return null;
  }

  async listSyncable(): Promise<readonly OutboxItem[]> {
    const all = [...this.items.values()];
    return all
      .filter((item) => item.status === 'PENDING' || item.status === 'FAILED_RETRYABLE')
      .filter((item) => {
        if (item.dependsOnOutboxId === null) return true;
        const dependency = this.items.get(item.dependsOnOutboxId);
        return dependency?.status === 'SYNCED';
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listAll(): Promise<readonly OutboxItem[]> {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async markInFlight(id: string): Promise<void> {
    this.mutate(id, { status: 'IN_FLIGHT' });
  }

  async markSynced(id: string): Promise<void> {
    this.mutate(id, { status: 'SYNCED' });
  }

  async markFailed(
    id: string,
    error: SyncError,
    status: Extract<OutboxStatus, 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'>,
    nextAttemptAt: string | null,
  ): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) throw new Error(`No outbox item ${id}`);
    this.items.set(id, {
      ...existing,
      status,
      attempts: existing.attempts + 1,
      lastError: error,
      nextAttemptAt,
      updatedAt: new Date().toISOString(),
    });
  }

  async recoverInFlightItems(staleAfterMs = 0): Promise<number> {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const recoveryError: SyncError = {
      kind: 'retryable',
      reason: 'PROCESS_INTERRUPTED',
      message: 'Recovered after process death; previous attempt outcome unknown',
      occurredAt: now,
    };

    let recovered = 0;
    for (const item of this.items.values()) {
      if (item.status === 'IN_FLIGHT' && item.updatedAt <= cutoff) {
        this.items.set(item.id, {
          ...item,
          status: 'FAILED_RETRYABLE',
          lastError: recoveryError,
          nextAttemptAt: null,
          updatedAt: now,
        });
        recovered += 1;
      }
    }
    return recovered;
  }

  private mutate(id: string, patch: Partial<OutboxItem>): void {
    const existing = this.items.get(id);
    if (!existing) throw new Error(`No outbox item ${id}`);
    this.items.set(id, { ...existing, ...patch, updatedAt: new Date().toISOString() });
  }
}
