import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/data/db/Migration';
import { migrations } from '../../../src/data/db/migrations';
import { SqliteOutboxRepository } from '../../../src/data/db/SqliteOutboxRepository';
import { asIdempotencyKey, type NewOutboxItem } from '../../../src/domain/sync/OutboxItem';
import type { OutboxRepository } from '../../../src/domain/sync/OutboxRepository';
import type { SyncError } from '../../../src/domain/sync/SyncError';
import { InMemoryOutboxRepository } from '../../helpers/InMemoryOutboxRepository';
import { createNodeSqliteTestDatabase } from '../../helpers/NodeSqliteTestDatabase';

function punchIn(overrides: Partial<NewOutboxItem> = {}): NewOutboxItem {
  return {
    id: 'outbox-punch-in-1',
    operation: 'PUNCH_IN',
    entityId: 'punch-in-1',
    idempotencyKey: asIdempotencyKey('idem-punch-in-1'),
    dependsOnOutboxId: null,
    payload: { punchId: 'punch-in-1' },
    createdAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

function punchOut(dependsOnOutboxId: string, overrides: Partial<NewOutboxItem> = {}): NewOutboxItem {
  return {
    id: 'outbox-punch-out-1',
    operation: 'PUNCH_OUT',
    entityId: 'punch-out-1',
    idempotencyKey: asIdempotencyKey('idem-punch-out-1'),
    dependsOnOutboxId,
    payload: { punchId: 'punch-out-1' },
    createdAt: '2026-08-18T17:00:00.000Z',
    ...overrides,
  };
}

const retryableError: SyncError = {
  kind: 'retryable',
  reason: 'NETWORK_UNREACHABLE',
  message: 'offline',
  occurredAt: '2026-08-18T09:05:00.000Z',
};

const terminalError: SyncError = {
  kind: 'terminal',
  reason: 'VALIDATION_REJECTED',
  message: 'server rejected payload',
  occurredAt: '2026-08-18T09:05:00.000Z',
};

/**
 * The full OutboxRepository behavioral contract, defined once here and
 * invoked against every implementation below (InMemoryOutboxRepository,
 * and SqliteOutboxRepository backed by a real Node SQLite engine). Every
 * `it()` in this function runs, unmodified, against whichever repository
 * `getRepo()` produces — so the two implementations are held to
 * byte-identical assertions rather than two hand-maintained copies that
 * can silently drift apart.
 */
function defineOutboxRepositoryContract(getRepo: () => OutboxRepository | Promise<OutboxRepository>): void {
  it('returns a PENDING item from listSyncable (invariant: pending items are returned)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());

    const syncable = await repo.listSyncable();
    expect(syncable.map((i) => i.id)).toEqual(['outbox-punch-in-1']);
    expect(syncable[0]?.status).toBe('PENDING');
  });

  it('excludes a SYNCED item from listSyncable', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.markInFlight('outbox-punch-in-1');
    await repo.markSynced('outbox-punch-in-1');

    expect(await repo.listSyncable()).toEqual([]);

    const item = await repo.getById('outbox-punch-in-1');
    expect(item?.status).toBe('SYNCED');
  });

  it('excludes a FAILED_TERMINAL item from listSyncable permanently (invariant 5)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.markInFlight('outbox-punch-in-1');
    await repo.markFailed('outbox-punch-in-1', terminalError, 'FAILED_TERMINAL', null);

    expect(await repo.listSyncable()).toEqual([]);

    const item = await repo.getById('outbox-punch-in-1');
    expect(item?.status).toBe('FAILED_TERMINAL');
    expect(item?.lastError).toEqual(terminalError);
  });

  it('returns a FAILED_RETRYABLE item from listSyncable (invariant 5)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.markInFlight('outbox-punch-in-1');
    await repo.markFailed('outbox-punch-in-1', retryableError, 'FAILED_RETRYABLE', '2026-08-18T09:06:00.000Z');

    const syncable = await repo.listSyncable();
    expect(syncable.map((i) => i.id)).toEqual(['outbox-punch-in-1']);
    expect(syncable[0]?.attempts).toBe(1);
    expect(syncable[0]?.lastError).toEqual(retryableError);
  });

  it('never returns an IN_FLIGHT item from listSyncable (no double-dispatch)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.markInFlight('outbox-punch-in-1');

    expect(await repo.listSyncable()).toEqual([]);
  });

  it('excludes a dependent item from listSyncable until its dependency is SYNCED (dependency ordering, invariants 3/4)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.insert(punchOut('outbox-punch-in-1'));

    const syncableBeforeDependencyResolved = await repo.listSyncable();
    expect(syncableBeforeDependencyResolved.map((i) => i.id)).toEqual(['outbox-punch-in-1']);
  });

  it('blocks a dependent whose dependency terminally failed (blocked dependents never auto-resolve)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.insert(punchOut('outbox-punch-in-1'));

    await repo.markInFlight('outbox-punch-in-1');
    await repo.markFailed('outbox-punch-in-1', terminalError, 'FAILED_TERMINAL', null);

    const syncable = await repo.listSyncable();
    expect(syncable.map((i) => i.id)).not.toContain('outbox-punch-out-1');

    const dependent = await repo.getById('outbox-punch-out-1');
    expect(dependent?.status).toBe('PENDING');
  });

  it('makes the dependent syncable once its dependency reaches SYNCED (dependency becomes available after prerequisite syncs)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.insert(punchOut('outbox-punch-in-1'));

    await repo.markInFlight('outbox-punch-in-1');
    await repo.markSynced('outbox-punch-in-1');

    const syncable = await repo.listSyncable();
    expect(syncable.map((i) => i.id)).toEqual(['outbox-punch-out-1']);
  });

  it('recovers IN_FLIGHT items to FAILED_RETRYABLE on process-death recovery (idempotency makes retry safe)', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());
    await repo.insert(punchOut('outbox-punch-in-1'));

    await repo.markInFlight('outbox-punch-in-1');

    const recoveredCount = await repo.recoverInFlightItems();
    expect(recoveredCount).toBe(1);

    const recovered = await repo.getById('outbox-punch-in-1');
    expect(recovered?.status).toBe('FAILED_RETRYABLE');
    expect(recovered?.lastError?.kind).toBe('retryable');
    expect(
      recovered?.lastError && 'reason' in recovered.lastError ? recovered.lastError.reason : null,
    ).toBe('PROCESS_INTERRUPTED');
    // Recovery is a status correction, not a counted sync attempt.
    expect(recovered?.attempts).toBe(0);

    const syncable = await repo.listSyncable();
    expect(syncable.map((i) => i.id)).toEqual(['outbox-punch-in-1']);
  });

  it('recoverInFlightItems is a no-op when nothing is IN_FLIGHT', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());

    const recoveredCount = await repo.recoverInFlightItems();
    expect(recoveredCount).toBe(0);

    const item = await repo.getById('outbox-punch-in-1');
    expect(item?.status).toBe('PENDING');
  });

  it(
    'recoverInFlightItems(staleAfterMs) leaves an item alone if it was claimed more recently than ' +
      'staleAfterMs ago — it might still be genuinely in progress',
    async () => {
      const repo = await getRepo();
      await repo.insert(punchIn());
      await repo.markInFlight('outbox-punch-in-1'); // claimed "now"

      // A full minute is comfortably longer than the time this test itself
      // takes to run, so this item is never actually stale relative to it.
      const recoveredCount = await repo.recoverInFlightItems(60_000);
      expect(recoveredCount).toBe(0);

      const item = await repo.getById('outbox-punch-in-1');
      expect(item?.status).toBe('IN_FLIGHT');
    },
  );

  it(
    'recoverInFlightItems() with no argument (the default) still recovers unconditionally, ' +
      'regardless of how recently the item was claimed — this is the cold-start behavior',
    async () => {
      const repo = await getRepo();
      await repo.insert(punchIn());
      await repo.markInFlight('outbox-punch-in-1'); // claimed "now"

      const recoveredCount = await repo.recoverInFlightItems(); // no staleAfterMs argument
      expect(recoveredCount).toBe(1);

      const item = await repo.getById('outbox-punch-in-1');
      expect(item?.status).toBe('FAILED_RETRYABLE');
    },
  );

  it(
    'recoverInFlightItems(0) is equivalent to no argument: also recovers unconditionally',
    async () => {
      const repo = await getRepo();
      await repo.insert(punchIn());
      await repo.markInFlight('outbox-punch-in-1');

      const recoveredCount = await repo.recoverInFlightItems(0);
      expect(recoveredCount).toBe(1);
    },
  );

  it('getByEntityId finds the outbox item for a given local entity id', async () => {
    const repo = await getRepo();
    await repo.insert(punchIn());

    const found = await repo.getByEntityId('punch-in-1');
    expect(found?.id).toBe('outbox-punch-in-1');

    const notFound = await repo.getByEntityId('does-not-exist');
    expect(notFound).toBeNull();
  });
}

describe('OutboxRepository contract — InMemoryOutboxRepository', () => {
  defineOutboxRepositoryContract(() => new InMemoryOutboxRepository());
});

describe('OutboxRepository contract — SqliteOutboxRepository (real SQLite engine)', () => {
  defineOutboxRepositoryContract(async () => {
    const db = createNodeSqliteTestDatabase();
    await runMigrations(db, migrations);
    return new SqliteOutboxRepository(db);
  });
});
