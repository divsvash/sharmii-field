import type { SqlDatabase } from '../../src/data/db/SqlDatabase';
import { runMigrations } from '../../src/data/db/Migration';
import { migrations } from '../../src/data/db/migrations';
import { SqliteOutboxDispatchStore } from '../../src/data/db/SqliteOutboxDispatchStore';
import { SqliteOutboxRepository } from '../../src/data/db/SqliteOutboxRepository';
import { dispatchOutboxItem } from '../../src/domain/sync/OutboxDispatcher';
import { selectEligibleOutboxItems } from '../../src/domain/sync/OutboxDispatchSelector';
import { asIdempotencyKey, type NewOutboxItem } from '../../src/domain/sync/OutboxItem';
import type { SyncError } from '../../src/domain/sync/SyncError';
import { FakeSyncTransport } from '../helpers/FakeSyncTransport';
import { createNodeSqliteTestDatabase } from '../helpers/NodeSqliteTestDatabase';

/**
 * These tests run the ACTUAL production SqliteOutboxDispatchStore (and, in
 * the concurrency test, the actual production dispatchOutboxItem) against
 * a real, running SQLite engine — Node's built-in node:sqlite, via the
 * same test-only adapter used throughout this project's integration
 * suite. The conditional-claim guarantee this store exists to provide can
 * only be trusted if it's proven against a real engine executing a real
 * UPDATE statement, not a mock.
 */

async function freshDb(): Promise<SqlDatabase> {
  const db = createNodeSqliteTestDatabase();
  await runMigrations(db, migrations);
  return db;
}

function newOutboxItem(overrides: Partial<NewOutboxItem> = {}): NewOutboxItem {
  return {
    id: 'outbox-1',
    operation: 'PUNCH_IN',
    entityId: 'punch-1',
    idempotencyKey: asIdempotencyKey('idem-outbox-1'),
    dependsOnOutboxId: null,
    payload: { punchId: 'punch-1' },
    createdAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

const retryableError: SyncError = {
  kind: 'retryable',
  reason: 'SERVER_UNAVAILABLE',
  message: 'HTTP 503',
  occurredAt: '2026-08-21T09:05:00.000Z',
};

const terminalError: SyncError = {
  kind: 'terminal',
  reason: 'VALIDATION_REJECTED',
  message: 'HTTP 400',
  occurredAt: '2026-08-21T09:05:00.000Z',
};

describe('SqliteOutboxDispatchStore.tryClaim — real SQLite engine', () => {
  it('claims a PENDING item and returns true', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());

    const claimed = await store.tryClaim('outbox-1');

    expect(claimed).toBe(true);
  });

  it('claims a FAILED_RETRYABLE item and returns true', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1'); // -> IN_FLIGHT
    await outboxRepo.markFailed('outbox-1', retryableError, 'FAILED_RETRYABLE', '2026-08-21T09:06:00.000Z');

    const claimed = await store.tryClaim('outbox-1');

    expect(claimed).toBe(true);
  });

  it('does not claim a SYNCED item', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');
    await store.markSynced('outbox-1');

    const claimed = await store.tryClaim('outbox-1');

    expect(claimed).toBe(false);
    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('SYNCED'); // unchanged by the failed claim attempt
  });

  it('does not claim a FAILED_TERMINAL item', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');
    await outboxRepo.markFailed('outbox-1', terminalError, 'FAILED_TERMINAL', null);

    const claimed = await store.tryClaim('outbox-1');

    expect(claimed).toBe(false);
    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('FAILED_TERMINAL'); // unchanged
  });

  it('does not claim a nonexistent item', async () => {
    const db = await freshDb();
    const store = new SqliteOutboxDispatchStore(db);

    const claimed = await store.tryClaim('does-not-exist');

    expect(claimed).toBe(false);
  });

  it('persists IN_FLIGHT after a successful claim', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());

    await store.tryClaim('outbox-1');

    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('IN_FLIGHT');
  });

  it('does not claim an already-IN_FLIGHT item (no double-dispatch)', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1'); // first claim succeeds

    const secondClaim = await store.tryClaim('outbox-1');

    expect(secondClaim).toBe(false);
  });
});

describe('SqliteOutboxDispatchStore.markSynced / markFailed — real SQLite engine', () => {
  it('markSynced persists SYNCED', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');

    await store.markSynced('outbox-1');

    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('SYNCED');
  });

  it('markFailed persists a retryable failure correctly', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');

    await store.markFailed('outbox-1', retryableError, 'FAILED_RETRYABLE', '2026-08-21T09:06:00.000Z');

    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('FAILED_RETRYABLE');
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toEqual(retryableError);
    // Still claimable again — FAILED_RETRYABLE is a syncable status.
    const reclaimed = await store.tryClaim('outbox-1');
    expect(reclaimed).toBe(true);
  });

  it('markFailed persists a terminal failure correctly', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');

    await store.markFailed('outbox-1', terminalError, 'FAILED_TERMINAL', null);

    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('FAILED_TERMINAL');
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toEqual(terminalError);
    // Never claimable again.
    const reclaimAttempt = await store.tryClaim('outbox-1');
    expect(reclaimAttempt).toBe(false);
  });
});

describe('SqliteOutboxDispatchStore — conditional claim under concurrent workers (real SQLite engine)', () => {
  it('worker B cannot claim an item worker A already claimed; transport is never called for worker B; state stays IN_FLIGHT until worker A completes it', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());

    // Both workers start from the same PENDING snapshot.
    const initialSnapshot = await outboxRepo.getById('outbox-1');
    expect(initialSnapshot?.status).toBe('PENDING');

    // Worker A claims directly (simulating "claimed, but hasn't finished
    // its transport call yet" — we don't call markSynced until later).
    const workerAClaimed = await store.tryClaim('outbox-1');
    expect(workerAClaimed).toBe(true);

    const afterWorkerAClaim = await outboxRepo.getById('outbox-1');
    expect(afterWorkerAClaim?.status).toBe('IN_FLIGHT');

    // Worker B, holding the same stale (still-PENDING) snapshot, attempts
    // a full dispatch through the real production dispatcher against the
    // same real store. The single conditional UPDATE — not a
    // SELECT-then-UPDATE in TypeScript — is what must reject it.
    const transportB = new FakeSyncTransport({ result: { outcome: 'success' } });
    const workerBResult = await dispatchOutboxItem(initialSnapshot!, transportB, store);

    expect(workerBResult).toEqual({ outcome: 'CLAIM_FAILED' });
    expect(transportB.calls).toHaveLength(0);

    // State is still IN_FLIGHT — worker A has not completed yet.
    const afterWorkerBAttempt = await outboxRepo.getById('outbox-1');
    expect(afterWorkerBAttempt?.status).toBe('IN_FLIGHT');

    // Worker A now completes.
    await store.markSynced('outbox-1');
    const final = await outboxRepo.getById('outbox-1');
    expect(final?.status).toBe('SYNCED');
  });

  it('a second sequential UPDATE against an IN_FLIGHT row affects zero rows (the raw claim guarantee)', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());

    const firstClaimResult = await db.runAsync(
      `UPDATE outbox_items
       SET status = 'IN_FLIGHT', updated_at = ?
       WHERE id = ? AND status IN ('PENDING', 'FAILED_RETRYABLE');`,
      ['2026-08-21T09:00:01.000Z', 'outbox-1'],
    );
    expect(firstClaimResult.changes).toBe(1);

    const secondClaimResult = await db.runAsync(
      `UPDATE outbox_items
       SET status = 'IN_FLIGHT', updated_at = ?
       WHERE id = ? AND status IN ('PENDING', 'FAILED_RETRYABLE');`,
      ['2026-08-21T09:00:02.000Z', 'outbox-1'],
    );
    expect(secondClaimResult.changes).toBe(0);

    // Confirms the same outcome through the actual store method too.
    const secondClaimViaStore = await store.tryClaim('outbox-1');
    expect(secondClaimViaStore).toBe(false);
  });
});

describe('retry-timing persistence — real SQLite engine (Phase 1)', () => {
  it('persists next_attempt_at on a retryable failure and it survives a re-read', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');

    await store.markFailed('outbox-1', retryableError, 'FAILED_RETRYABLE', '2026-08-21T09:10:00.000Z');

    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('FAILED_RETRYABLE');
    expect(item?.nextAttemptAt).toBe('2026-08-21T09:10:00.000Z');
  });

  it('persists next_attempt_at as null for a terminal failure', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');

    await store.markFailed('outbox-1', terminalError, 'FAILED_TERMINAL', null);

    const item = await outboxRepo.getById('outbox-1');
    expect(item?.status).toBe('FAILED_TERMINAL');
    expect(item?.nextAttemptAt).toBeNull();
  });

  it('starts a freshly-inserted item with next_attempt_at null', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    await outboxRepo.insert(newOutboxItem());

    const item = await outboxRepo.getById('outbox-1');
    expect(item?.nextAttemptAt).toBeNull();
  });

  it('clears a stale next_attempt_at back to null on process-death recovery', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');
    await store.markFailed('outbox-1', retryableError, 'FAILED_RETRYABLE', '2026-08-21T09:10:00.000Z');

    // Item becomes eligible again later, gets re-claimed, then the
    // process dies while IN_FLIGHT (abandoned before markSynced/markFailed).
    await store.tryClaim('outbox-1');
    const abandoned = await outboxRepo.getById('outbox-1');
    expect(abandoned?.status).toBe('IN_FLIGHT');

    const recoveredCount = await outboxRepo.recoverInFlightItems();
    expect(recoveredCount).toBe(1);

    const recovered = await outboxRepo.getById('outbox-1');
    expect(recovered?.status).toBe('FAILED_RETRYABLE');
    expect(recovered?.nextAttemptAt).toBeNull(); // immediately eligible, not stuck on the old schedule
  });

  it('selectEligibleOutboxItems excludes a FAILED_RETRYABLE row from real SQLite whose next_attempt_at has not elapsed, and includes it once it has', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const store = new SqliteOutboxDispatchStore(db);
    await outboxRepo.insert(newOutboxItem());
    await store.tryClaim('outbox-1');
    await store.markFailed('outbox-1', retryableError, 'FAILED_RETRYABLE', '2026-08-21T10:00:00.000Z');

    const snapshot = await outboxRepo.listAll();

    const beforeWindow = selectEligibleOutboxItems(snapshot, '2026-08-21T09:59:59.000Z');
    expect(beforeWindow).toEqual([]);

    const afterWindow = selectEligibleOutboxItems(snapshot, '2026-08-21T10:00:01.000Z');
    expect(afterWindow.map((i) => i.id)).toEqual(['outbox-1']);
  });
});
