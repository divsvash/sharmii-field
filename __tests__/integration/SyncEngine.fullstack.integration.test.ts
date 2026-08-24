import type { SqlDatabase } from '../../src/data/db/SqlDatabase';
import { runMigrations } from '../../src/data/db/Migration';
import { migrations } from '../../src/data/db/migrations';
import { SqliteOutboxDispatchStore } from '../../src/data/db/SqliteOutboxDispatchStore';
import { SqliteOutboxRepository } from '../../src/data/db/SqliteOutboxRepository';
import { HttpSyncTransport } from '../../src/data/api/HttpSyncTransport';
import { dispatchOutboxItem } from '../../src/domain/sync/OutboxDispatcher';
import { SyncEngine } from '../../src/domain/sync/SyncEngine';
import { asIdempotencyKey, type NewOutboxItem } from '../../src/domain/sync/OutboxItem';
import type { RetryPolicyConfig } from '../../src/domain/sync/RetryPolicy';
import { createNodeSqliteTestDatabase } from '../helpers/NodeSqliteTestDatabase';
import { MockApiServer } from '../helpers/MockApiServer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    // recoveryStaleAfterMs: 0 — this test is a smoke test for the recovery
    // mechanism itself (claim, die, come back, retry succeeds), not for
    // the staleness threshold specifically (see the dedicated staleness
    // tests above/below for that); tryClaim and runOnce() happen back to
    // back here, which the real default (non-zero) threshold would
    // correctly treat as "possibly still live" and refuse to touch.
    const engine = new SyncEngine(outboxRepo, dispatchStore, transport, undefined, undefined, 0);

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
    'Fix proof: a genuinely-live in-flight claim is NOT reclaimed by a concurrently-running ' +
      "engine's recovery step — worker B's recovery leaves worker A's fresh claim alone, so " +
      'no duplicate HTTP request is made for the same item',
    async () => {
      const db = await freshDb();
      const outboxRepoA = new SqliteOutboxRepository(db);
      const dispatchStoreA = new SqliteOutboxDispatchStore(db);
      const outboxRepoB = new SqliteOutboxRepository(db);
      const dispatchStoreB = new SqliteOutboxDispatchStore(db);
      const transportB = new HttpSyncTransport({ baseUrl: server.baseUrl });

      await outboxRepoA.insert(newOutboxItem({ id: 'A' }));
      server.setDefaultResponse(200);

      await dispatchStoreA.tryClaim('A'); // worker A begins dispatch, holds the row — updated_at is "now"

      // Worker B's own runOnce() call, using the engine's default
      // recovery staleness threshold (DEFAULT_RECOVERY_STALE_AFTER_MS).
      // A's claim is only moments old, nowhere near stale.
      const engineB = new SyncEngine(outboxRepoB, dispatchStoreB, transportB);
      const summaryB = await engineB.runOnce();

      // The bug this used to demonstrate is fixed: worker B's recovery
      // step correctly leaves A's fresh claim alone, so B has nothing
      // eligible to select, makes no request, and never touches item A.
      expect(summaryB.recovered).toBe(0);
      expect(summaryB.attempted).toBe(0);
      expect(summaryB.succeeded).toBe(0);
      expect(server.requests).toHaveLength(0);

      // Worker A still legitimately holds the claim, exactly as it left it.
      const stateWhileALive = await outboxRepoA.getById('A');
      expect(stateWhileALive?.status).toBe('IN_FLIGHT');

      // Worker A finishing its own dispatch normally afterward is
      // unaffected by B's run having happened.
      await dispatchStoreA.markSynced('A');
      const finalState = await outboxRepoA.getById('A');
      expect(finalState?.status).toBe('SYNCED');
    },
  );

  it(
    'A genuinely-abandoned (stale) IN_FLIGHT item is still recovered and successfully ' +
      're-dispatched by a later run — the staleness threshold does not break real crash recovery',
    async () => {
      const db = await freshDb();
      const outboxRepo = new SqliteOutboxRepository(db);
      const dispatchStore = new SqliteOutboxDispatchStore(db);
      const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });

      await outboxRepo.insert(newOutboxItem({ id: 'A' }));
      server.setDefaultResponse(200);

      await dispatchStore.tryClaim('A'); // simulates a worker that then died mid-dispatch

      // Directly backdate updated_at, simulating real elapsed time having
      // passed since the (now-dead) process claimed this row — the same
      // technique the atomicity/rollback tests use to reach into real
      // SQLite state directly rather than waiting on the real clock.
      const longAgo = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 minutes ago
      await db.runAsync(`UPDATE outbox_items SET updated_at = ? WHERE id = ?;`, [longAgo, 'A']);

      const engine = new SyncEngine(outboxRepo, dispatchStore, transport); // default 60s threshold
      const summary = await engine.runOnce();

      expect(summary.recovered).toBe(1);
      expect(summary.attempted).toBe(1);
      expect(summary.succeeded).toBe(1);
      expect(server.requests).toHaveLength(1);

      const finalState = await outboxRepo.getById('A');
      expect(finalState?.status).toBe('SYNCED');
    },
  );

  it(
    'Crash-recovery-to-dedup, end to end: claim -> send -> "die" before markSynced -> recover -> ' +
      'retry -> exactly one real server-side application, when the server implements idempotency ' +
      'dedup (MockApiServer.enableIdempotencyDedup)',
    async () => {
      const db = await freshDb();
      const outboxRepo = new SqliteOutboxRepository(db);
      const dispatchStore = new SqliteOutboxDispatchStore(db);
      const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });

      server.enableIdempotencyDedup();
      server.queueResponse(200);

      await outboxRepo.insert(newOutboxItem({ id: 'A' }));

      // "claim -> send": the real claim, then the real HTTP request —
      // exactly what OutboxDispatcher would do — but calling
      // transport.send() directly rather than going through
      // dispatchOutboxItem()/markSynced(), to model the crash precisely:
      // the server received and genuinely applied the mutation, but the
      // process died before it could persist that outcome locally.
      await dispatchStore.tryClaim('A');
      const sendResult = await transport.send({
        operation: 'PUNCH_IN',
        entityId: 'entity-A',
        idempotencyKey: asIdempotencyKey('idem-A'),
        payload: { note: 'payload for A' },
      });
      expect(sendResult).toEqual({ outcome: 'success' }); // the server really did apply it
      expect(server.appliedMutationCount).toBe(1);
      // ...and then the process "dies" here: markSynced is never called.
      // Item A is left IN_FLIGHT in the database, exactly as a real crash
      // would leave it.

      // Backdate updated_at so the recovery staleness threshold (see the
      // recovery-vs-concurrency fix proof above) treats this as
      // genuinely abandoned rather than "possibly still live."
      const longAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      await db.runAsync(`UPDATE outbox_items SET updated_at = ? WHERE id = ?;`, [longAgo, 'A']);

      // "recover -> retry": a fresh engine run, as if the app restarted.
      // Queued in case dedup were somehow bypassed — if this response
      // actually gets consumed, appliedMutationCount below would catch it.
      server.queueResponse(200);
      const engine = new SyncEngine(outboxRepo, dispatchStore, transport);
      const summary = await engine.runOnce();

      expect(summary.recovered).toBe(1);
      expect(summary.succeeded).toBe(1); // the client correctly sees this as a successful sync...
      expect(server.appliedMutationCount).toBe(1); // ...but the server never re-applied it a second time
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]?.deduped).toBe(true); // the retry was recognized and replayed, not re-run

      const item = await outboxRepo.getById('A');
      expect(item?.status).toBe('SYNCED');
    },
  );

  it(
    'Crash-recovery WITHOUT server-side dedup (today\'s honest baseline): the same claim -> send -> ' +
      '"die" -> recover -> retry sequence applies the mutation a second time',
    async () => {
      const db = await freshDb();
      const outboxRepo = new SqliteOutboxRepository(db);
      const dispatchStore = new SqliteOutboxDispatchStore(db);
      const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });

      // enableIdempotencyDedup() deliberately not called — this codebase
      // has no real server, so this is the behavior it actually ships
      // with today: nothing stops a duplicate application.
      server.queueResponse(200);

      await outboxRepo.insert(newOutboxItem({ id: 'A' }));

      await dispatchStore.tryClaim('A');
      await transport.send({
        operation: 'PUNCH_IN',
        entityId: 'entity-A',
        idempotencyKey: asIdempotencyKey('idem-A'),
        payload: { note: 'payload for A' },
      });
      expect(server.appliedMutationCount).toBe(1);

      const longAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      await db.runAsync(`UPDATE outbox_items SET updated_at = ? WHERE id = ?;`, [longAgo, 'A']);

      server.queueResponse(200);
      const engine = new SyncEngine(outboxRepo, dispatchStore, transport);
      const summary = await engine.runOnce();

      expect(summary.succeeded).toBe(1);
      expect(server.appliedMutationCount).toBe(2); // applied twice — exactly the gap the dedup test above closes
    },
  );

  it(
    'Retry limit: a persistently-failing item stops retrying and becomes FAILED_TERMINAL ' +
      '(RETRY_LIMIT_EXCEEDED) after maxAttempts, against real SQLite and a real HTTP server, ' +
      'and is never dispatched again',
    async () => {
      const db = await freshDb();
      const outboxRepo = new SqliteOutboxRepository(db);
      const dispatchStore = new SqliteOutboxDispatchStore(db);
      const transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
      const smallLimitConfig: RetryPolicyConfig = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1000 };

      // A controlled, monotonically-advancing clock (rather than the real
      // wall clock) so each simulated "app restart" deterministically lands
      // after the previous failure's nextAttemptAt, with no timing flakiness.
      let currentTime = new Date('2026-08-22T09:00:00.000Z').getTime();
      const advancingNow = () => {
        currentTime += 5 * 60 * 1000; // 5 minutes per call — comfortably past any 1s backoff
        return new Date(currentTime).toISOString();
      };

      const engine = new SyncEngine(outboxRepo, dispatchStore, transport, advancingNow, smallLimitConfig);

      server.setDefaultResponse(503); // every request fails retryably, forever
      await outboxRepo.insert(newOutboxItem({ id: 'A', createdAt: '2026-08-22T08:00:00.000Z' }));

      // Each runOnce() call is one attempt, mirroring separate
      // app-restarts/connectivity events over time.
      await engine.runOnce();
      await engine.runOnce();
      const finalSummary = await engine.runOnce();

      expect(server.requests).toHaveLength(3); // exactly maxAttempts real HTTP requests, not more
      expect(finalSummary.retryLimitExceeded).toBe(1);

      const item = await outboxRepo.getById('A');
      expect(item?.status).toBe('FAILED_TERMINAL');
      expect(item?.lastError?.kind).toBe('terminal');
      expect(item?.lastError && 'reason' in item.lastError ? item.lastError.reason : null).toBe(
        'RETRY_LIMIT_EXCEEDED',
      );

      // A further sync pass must not touch it again.
      const afterExhaustion = await engine.runOnce();
      expect(server.requests).toHaveLength(3);
      expect(afterExhaustion.attempted).toBe(0);
    },
  );
});
