import type { SqlDatabase } from '../../src/data/db/SqlDatabase';
import { runMigrations } from '../../src/data/db/Migration';
import { migrations } from '../../src/data/db/migrations';
import { SqliteOutboxDispatchStore } from '../../src/data/db/SqliteOutboxDispatchStore';
import { SqliteOutboxRepository } from '../../src/data/db/SqliteOutboxRepository';
import { HttpSyncTransport } from '../../src/data/api/HttpSyncTransport';
import { dispatchOutboxItem } from '../../src/domain/sync/OutboxDispatcher';
import { SyncEngine } from '../../src/domain/sync/SyncEngine';
import { asIdempotencyKey, type NewOutboxItem } from '../../src/domain/sync/OutboxItem';
import { createNodeSqliteTestDatabase } from '../helpers/NodeSqliteTestDatabase';
import { MockApiServer } from '../helpers/MockApiServer';

/**
 * The complete production path, proven end to end against real
 * infrastructure on both sides:
 *
 *   SqliteOutboxRepository / SqliteOutboxDispatchStore  (real SQLite, via node:sqlite)
 *         -> SyncEngine.runOnce()
 *              -> OutboxDispatchSelector (unmodified)
 *              -> OutboxDispatcher (unmodified)
 *                   -> HttpSyncTransport (real fetch)
 *                        -> MockApiServer (real Node http server, real socket)
 *
 * No mocked transport, no in-memory fake store — every collaborator here
 * is the real production class.
 */

async function freshDb(): Promise<SqlDatabase> {
  const db = createNodeSqliteTestDatabase();
  await runMigrations(db, migrations);
  return db;
}

function newOutboxItem(overrides: Partial<NewOutboxItem> & Pick<NewOutboxItem, 'id'>): NewOutboxItem {
  return {
    operation: 'PUNCH_IN',
    entityId: `entity-${overrides.id}`,
    idempotencyKey: asIdempotencyKey(`idem-${overrides.id}`),
    dependsOnOutboxId: null,
    payload: { note: `payload for ${overrides.id}` },
    createdAt: '2026-08-23T09:00:00.000Z',
    ...overrides,
  };
}

describe('Full-stack SyncEngine integration (real SQLite + real HTTP)', () => {
  let server: MockApiServer;

  beforeEach(async () => {
    server = await MockApiServer.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('Success: PENDING -> IN_FLIGHT -> API 200 -> SYNCED', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const dispatchStore = new SqliteOutboxDispatchStore(db);
    const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
    const engine = new SyncEngine(outboxRepo, dispatchStore, transport);

    server.queueResponse(200);
    await outboxRepo.insert(newOutboxItem({ id: 'A' }));

    const summary = await engine.runOnce();

    expect(summary.succeeded).toBe(1);
    const item = await outboxRepo.getById('A');
    expect(item?.status).toBe('SYNCED');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.idempotencyKey).toBe('idem-A');
  });

  it('Retryable failure: PENDING -> IN_FLIGHT -> API 500 -> FAILED_RETRYABLE -> nextAttemptAt persisted', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const dispatchStore = new SqliteOutboxDispatchStore(db);
    const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
    const engine = new SyncEngine(outboxRepo, dispatchStore, transport);

    server.queueResponse(500);
    await outboxRepo.insert(newOutboxItem({ id: 'A' }));

    const summary = await engine.runOnce();

    expect(summary.retryableFailures).toBe(1);
    const item = await outboxRepo.getById('A');
    expect(item?.status).toBe('FAILED_RETRYABLE');
    expect(item?.nextAttemptAt).not.toBeNull();
    expect(item?.attempts).toBe(1);
  });

  it('Terminal failure: PENDING -> IN_FLIGHT -> API 400 -> FAILED_TERMINAL', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const dispatchStore = new SqliteOutboxDispatchStore(db);
    const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
    const engine = new SyncEngine(outboxRepo, dispatchStore, transport);

    server.queueResponse(400);
    await outboxRepo.insert(newOutboxItem({ id: 'A' }));

    const summary = await engine.runOnce();

    expect(summary.terminalFailures).toBe(1);
    const item = await outboxRepo.getById('A');
    expect(item?.status).toBe('FAILED_TERMINAL');
    expect(item?.nextAttemptAt).toBeNull();
  });

  it('Dependency chain A -> B -> C: successful A allows B, successful B allows C, all within one run', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const dispatchStore = new SqliteOutboxDispatchStore(db);
    const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
    const engine = new SyncEngine(outboxRepo, dispatchStore, transport);

    server.setDefaultResponse(200);
    await outboxRepo.insert(newOutboxItem({ id: 'A', createdAt: '2026-08-23T09:00:00.000Z' }));
    await outboxRepo.insert(
      newOutboxItem({ id: 'B', dependsOnOutboxId: 'A', createdAt: '2026-08-23T09:01:00.000Z' }),
    );
    await outboxRepo.insert(
      newOutboxItem({ id: 'C', dependsOnOutboxId: 'B', createdAt: '2026-08-23T09:02:00.000Z' }),
    );

    const summary = await engine.runOnce();

    expect(summary.succeeded).toBe(3);
    expect(summary.passes).toBe(3);
    for (const id of ['A', 'B', 'C']) {
      const item = await outboxRepo.getById(id);
      expect(item?.status).toBe('SYNCED');
    }
    expect(server.requests.map((r) => r.idempotencyKey)).toEqual(['idem-A', 'idem-B', 'idem-C']);
  });

  it('Failed prerequisite: B remains blocked (never dispatched, never sent to the server) when A fails', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const dispatchStore = new SqliteOutboxDispatchStore(db);
    const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
    const engine = new SyncEngine(outboxRepo, dispatchStore, transport);

    server.queueResponse(400); // A fails terminally
    await outboxRepo.insert(newOutboxItem({ id: 'A', createdAt: '2026-08-23T09:00:00.000Z' }));
    await outboxRepo.insert(
      newOutboxItem({ id: 'B', dependsOnOutboxId: 'A', createdAt: '2026-08-23T09:01:00.000Z' }),
    );

    const summary = await engine.runOnce();

    expect(summary.terminalFailures).toBe(1);
    expect(summary.blocked).toBe(1);
    const bItem = await outboxRepo.getById('B');
    expect(bItem?.status).toBe('PENDING');
    expect(server.requests).toHaveLength(1); // only A was ever sent
    expect(server.requests[0]?.idempotencyKey).toBe('idem-A');
  });

  it('Recovery: IN_FLIGHT -> process recovery -> FAILED_RETRYABLE -> eventually dispatched again (and succeeds)', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);
    const dispatchStore = new SqliteOutboxDispatchStore(db);
    const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
    const engine = new SyncEngine(outboxRepo, dispatchStore, transport);

    await outboxRepo.insert(newOutboxItem({ id: 'A' }));
    // Simulate a prior process having claimed this item and then dying
    // before recording the outcome.
    await dispatchStore.tryClaim('A');
    const abandoned = await outboxRepo.getById('A');
    expect(abandoned?.status).toBe('IN_FLIGHT');

    server.queueResponse(200);
    const summary = await engine.runOnce();

    expect(summary.recovered).toBe(1);
    expect(summary.succeeded).toBe(1);
    const item = await outboxRepo.getById('A');
    expect(item?.status).toBe('SYNCED');
    expect(server.requests).toHaveLength(1); // dispatched exactly once, this run
  });

  it('Concurrency: the conditional claim prevents two workers from both dispatching the same item', async () => {
    const db = await freshDb();
    const outboxRepoA = new SqliteOutboxRepository(db);
    const dispatchStoreA = new SqliteOutboxDispatchStore(db);
    const dispatchStoreB = new SqliteOutboxDispatchStore(db);
    const transportB = new HttpSyncTransport({ baseUrl: server.baseUrl });

    await outboxRepoA.insert(newOutboxItem({ id: 'A' }));
    server.setDefaultResponse(200);

    // Worker A claims first (simulating it's mid-dispatch, holding the row).
    const claimedByWorkerA = await dispatchStoreA.tryClaim('A');
    expect(claimedByWorkerA).toBe(true);

    // Worker B independently attempts the same conditional claim, via the
    // real dispatcher, against the same real database row.
    const staleSnapshotForWorkerB = await outboxRepoA.getById('A'); // worker B's last-known (now stale) view
    const workerBOutcome = await dispatchOutboxItem(
      // Worker B thinks the item is still PENDING/whatever it looked like
      // before worker A claimed it — the point is the store, not this
      // stale object, is what actually protects the row.
      { ...staleSnapshotForWorkerB!, status: 'PENDING' },
      transportB,
      dispatchStoreB,
    );

    expect(workerBOutcome).toEqual({ outcome: 'CLAIM_FAILED' });
    expect(server.requests).toHaveLength(0); // worker B never sent anything

    // Worker A completes; the row is exactly SYNCED once.
    await dispatchStoreA.markSynced('A');
    const finalState = await outboxRepoA.getById('A');
    expect(finalState?.status).toBe('SYNCED');
  });

  it(
    'Known limitation (documented, not silently accepted): SyncEngine.runOnce() recovers ' +
      'abandoned IN_FLIGHT items unconditionally at the start of every run, with no way to ' +
      "distinguish a genuinely-dead process's abandoned item from one a concurrently-running " +
      'live worker still legitimately owns. A second engine instance calling runOnce() while ' +
      "the first is still mid-dispatch will \"recover\" and re-dispatch that item itself. The " +
      'atomic tryClaim guarantee (proven above) is not violated by this — the DB still allows ' +
      'only one caller to hold IN_FLIGHT at a time — but recovery can hand a second worker a ' +
      "fresh claim on an item the first worker hasn't actually abandoned. This is a real gap, " +
      'not addressed in this sprint (see README "Known limitations"): recovery has no lease/' +
      'heartbeat/owner-identity concept, so it cannot tell "dead" from "busy".',
    async () => {
      const db = await freshDb();
      const outboxRepoA = new SqliteOutboxRepository(db);
      const dispatchStoreA = new SqliteOutboxDispatchStore(db);
      const outboxRepoB = new SqliteOutboxRepository(db);
      const dispatchStoreB = new SqliteOutboxDispatchStore(db);
      const transportB = new HttpSyncTransport({ baseUrl: server.baseUrl });

      await outboxRepoA.insert(newOutboxItem({ id: 'A' }));
      server.setDefaultResponse(200);

      await dispatchStoreA.tryClaim('A'); // worker A begins dispatch, holds the row

      const engineB = new SyncEngine(outboxRepoB, dispatchStoreB, transportB);
      const summaryB = await engineB.runOnce();

      // Demonstrates the limitation: worker B's own recovery step treated
      // A's IN_FLIGHT status as abandoned, and worker B went ahead and
      // dispatched (and, with the server returning 200, synced) it.
      expect(summaryB.recovered).toBe(1);
      expect(summaryB.attempted).toBe(1);
      expect(summaryB.succeeded).toBe(1);
      expect(server.requests).toHaveLength(1);

      const finalState = await outboxRepoA.getById('A');
      expect(finalState?.status).toBe('SYNCED');
    },
  );
});
