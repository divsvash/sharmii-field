import { SyncEngine } from '../../../src/domain/sync/SyncEngine';
import { asIdempotencyKey, type OutboxItem, type OutboxStatus } from '../../../src/domain/sync/OutboxItem';
import type { RetryPolicyConfig } from '../../../src/domain/sync/RetryPolicy';
import { describe, expect, it } from 'vitest';
import { FakeSyncTransport } from '../../helpers/FakeSyncTransport';
import { InMemoryOutboxDispatchStore } from '../../helpers/InMemoryOutboxDispatchStore';
import { InMemoryOutboxStore } from '../../helpers/InMemoryOutboxStore';

function makeItem(overrides: Partial<OutboxItem> & Pick<OutboxItem, 'id'>): OutboxItem {
  return {
    operation: 'PUNCH_IN',
    entityId: `entity-${overrides.id}`,
    idempotencyKey: asIdempotencyKey(`idem-${overrides.id}`),
    dependsOnOutboxId: null,
    payload: {},
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: '2026-08-22T09:00:00.000Z',
    updatedAt: '2026-08-22T09:00:00.000Z',
    ...overrides,
  };
}

describe('SyncEngine.runOnce — empty outbox', () => {
  it('is a clean no-op with a zeroed summary', async () => {
    const store = new InMemoryOutboxStore([]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary).toEqual({
      recovered: 0,
      passes: 0,
      attempted: 0,
      succeeded: 0,
      retryableFailures: 0,
      terminalFailures: 0,
      claimFailures: 0,
      blocked: 0,
      waitingForRetry: 0,
      retryLimitExceeded: 0,
    });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('SyncEngine.runOnce — single eligible item', () => {
  it('dispatches it exactly once and reports success', async () => {
    const item = makeItem({ id: 'A' });
    const store = new InMemoryOutboxStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.passes).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(store.getStatus('A')).toBe('SYNCED');
  });
});

describe('SyncEngine.runOnce — multiple eligible items, deterministic ordering', () => {
  it('dispatches independent items in createdAt order, sequentially', async () => {
    const b = makeItem({ id: 'B', createdAt: '2026-08-22T09:02:00.000Z' });
    const a = makeItem({ id: 'A', createdAt: '2026-08-22T09:01:00.000Z' });
    const c = makeItem({ id: 'C', createdAt: '2026-08-22T09:03:00.000Z' });
    // Constructed in a shuffled order to prove the engine's dispatch order
    // comes from the selector, not from insertion/array order.
    const store = new InMemoryOutboxStore([b, a, c]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.succeeded).toBe(3);
    expect(transport.calls.map((call) => call.entityId)).toEqual(['entity-A', 'entity-B', 'entity-C']);
  });
});

describe('SyncEngine.runOnce — dependency progression within one run', () => {
  it('dispatches B in the same run once A succeeds, without waiting for a second runOnce() call', async () => {
    const a = makeItem({ id: 'A', createdAt: '2026-08-22T09:00:00.000Z' });
    const b = makeItem({ id: 'B', dependsOnOutboxId: 'A', createdAt: '2026-08-22T09:01:00.000Z' });
    const store = new InMemoryOutboxStore([a, b]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.succeeded).toBe(2);
    expect(summary.passes).toBe(2); // pass 1: [A]; pass 2 (A now SYNCED): [B]
    expect(transport.calls.map((call) => call.entityId)).toEqual(['entity-A', 'entity-B']);
    expect(store.getStatus('A')).toBe('SYNCED');
    expect(store.getStatus('B')).toBe('SYNCED');
  });
});

describe('SyncEngine.runOnce — dependency blocked by retryable failure', () => {
  it('keeps B blocked and never dispatches it when A fails retryably', async () => {
    const a = makeItem({ id: 'A', createdAt: '2026-08-22T09:00:00.000Z' });
    const b = makeItem({ id: 'B', dependsOnOutboxId: 'A', createdAt: '2026-08-22T09:01:00.000Z' });
    const store = new InMemoryOutboxStore([a, b]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 503 } },
    });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.attempted).toBe(1); // only A — B was never selected, so never dispatched
    expect(summary.retryableFailures).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.blocked).toBe(1); // B
    expect(transport.calls.map((call) => call.entityId)).toEqual(['entity-A']);
    expect(store.getStatus('A')).toBe('FAILED_RETRYABLE');
    expect(store.getStatus('B')).toBe('PENDING');
  });
});

describe('SyncEngine.runOnce — dependency blocked by terminal failure', () => {
  it('keeps B blocked and never dispatches it when A fails terminally', async () => {
    const a = makeItem({ id: 'A', createdAt: '2026-08-22T09:00:00.000Z' });
    const b = makeItem({ id: 'B', dependsOnOutboxId: 'A', createdAt: '2026-08-22T09:01:00.000Z' });
    const store = new InMemoryOutboxStore([a, b]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 400 } },
    });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.attempted).toBe(1);
    expect(summary.terminalFailures).toBe(1);
    expect(summary.blocked).toBe(1); // B, permanently
    expect(transport.calls.map((call) => call.entityId)).toEqual(['entity-A']);
    expect(store.getStatus('A')).toBe('FAILED_TERMINAL');
    expect(store.getStatus('B')).toBe('PENDING');
  });
});

describe('SyncEngine.runOnce — abandoned IN_FLIGHT recovery', () => {
  it('recovers an abandoned IN_FLIGHT item before selection, and it participates in this same run', async () => {
    // updatedAt comes from makeItem's fixed default (2026-08-22), which is
    // always far older than DEFAULT_RECOVERY_STALE_AFTER_MS (60s) relative
    // to the real wall clock this test runs under — genuinely abandoned,
    // not just "old enough to pass a lenient check."
    const abandoned = makeItem({ id: 'A', status: 'IN_FLIGHT' });
    const store = new InMemoryOutboxStore([abandoned]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.recovered).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(store.getStatus('A')).toBe('SYNCED');
  });

  it('does NOT recover (or dispatch) an item claimed moments ago — it may be genuinely owned by a still-live sibling call', async () => {
    const justClaimed = makeItem({ id: 'A', status: 'IN_FLIGHT', updatedAt: new Date().toISOString() });
    const store = new InMemoryOutboxStore([justClaimed]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport); // default recoveryStaleAfterMs (60s)

    const summary = await engine.runOnce();

    expect(summary.recovered).toBe(0);
    expect(summary.attempted).toBe(0);
    expect(transport.calls).toHaveLength(0);
    expect(store.getStatus('A')).toBe('IN_FLIGHT'); // left exactly as a live owner would need it to be
  });

  it('a recoveryStaleAfterMs of 0 passed to the constructor recovers even a just-claimed item immediately — proves the threshold is actually wired through, not hardcoded', async () => {
    const justClaimed = makeItem({ id: 'A', status: 'IN_FLIGHT', updatedAt: new Date().toISOString() });
    const store = new InMemoryOutboxStore([justClaimed]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport, undefined, undefined, 0);

    const summary = await engine.runOnce();

    expect(summary.recovered).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(store.getStatus('A')).toBe('SYNCED');
  });
});

describe('SyncEngine.runOnce — already-terminal items are not dispatched', () => {
  it.each<OutboxStatus>(['SYNCED', 'FAILED_TERMINAL'])(
    'does not dispatch an item already in status %s',
    async (status) => {
      const item = makeItem({ id: 'A', status });
      const store = new InMemoryOutboxStore([item]);
      const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
      const engine = new SyncEngine(store, store, transport);

      const summary = await engine.runOnce();

      expect(summary.attempted).toBe(0);
      expect(transport.calls).toHaveLength(0);
      expect(store.getStatus('A')).toBe(status);
    },
  );
});

describe('SyncEngine.runOnce — claim failure does not invoke transport', () => {
  it('counts a claim failure and never calls the transport, when a concurrent claim wins the race', async () => {
    // Simulates a genuine race: the snapshot source (what selection sees)
    // still reports the item PENDING, but the dispatch store — the
    // authority the actual claim goes through — reports it already
    // claimed by someone else. This is the only way to reach CLAIM_FAILED
    // from the engine's perspective without true concurrency: two
    // independent views of the same conceptual row, exactly like two
    // separate worker processes racing over the same database.
    const item = makeItem({ id: 'A', status: 'PENDING' });
    const outboxSource = new InMemoryOutboxStore([item]);
    const dispatchStore = new InMemoryOutboxDispatchStore([{ ...item, status: 'IN_FLIGHT' }]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(outboxSource, dispatchStore, transport);

    const summary = await engine.runOnce();

    expect(summary.attempted).toBe(1);
    expect(summary.claimFailures).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('SyncEngine.runOnce — terminates when no further progress is possible', () => {
  it('does not loop forever retrying a persistently-failing item within the same run', async () => {
    const item = makeItem({ id: 'A' });
    const store = new InMemoryOutboxStore([item]);
    // Every attempt fails retryably — if the engine looped on
    // FAILED_RETRYABLE items without tracking "already attempted this
    // run", this would hang.
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 503 } },
    });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.passes).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(summary.retryableFailures).toBe(1);
    expect(transport.calls).toHaveLength(1); // not looped
    expect(store.getStatus('A')).toBe('FAILED_RETRYABLE');
  });

  it('terminates after multiple passes once no new work is unblocked', async () => {
    // A -> B -> C chain: each pass unblocks exactly the next one.
    const a = makeItem({ id: 'A', createdAt: '2026-08-22T09:00:00.000Z' });
    const b = makeItem({ id: 'B', dependsOnOutboxId: 'A', createdAt: '2026-08-22T09:01:00.000Z' });
    const c = makeItem({ id: 'C', dependsOnOutboxId: 'B', createdAt: '2026-08-22T09:02:00.000Z' });
    const store = new InMemoryOutboxStore([a, b, c]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport);

    const summary = await engine.runOnce();

    expect(summary.passes).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.blocked).toBe(0);
  });
});

describe('SyncEngine.runOnce — no timers, no sleeping, no background loop', () => {
  it('resolves without needing fake timers advanced, and schedules no timers', async () => {
    jest.useFakeTimers();
    try {
      const item = makeItem({ id: 'A' });
      const store = new InMemoryOutboxStore([item]);
      const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
      const engine = new SyncEngine(store, store, transport);

      const summary = await engine.runOnce();

      expect(summary.succeeded).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SyncEngine.runOnce — sequential dispatch (no concurrency)', () => {
  it('does not start a second dispatch before the first resolves', async () => {
    const a = makeItem({ id: 'A', createdAt: '2026-08-22T09:00:00.000Z' });
    const b = makeItem({ id: 'B', createdAt: '2026-08-22T09:01:00.000Z' });
    const store = new InMemoryOutboxStore([a, b]);

    let inFlightCount = 0;
    let maxConcurrent = 0;
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const originalSend = transport.send.bind(transport);
    transport.send = async (request) => {
      inFlightCount += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlightCount);
      const result = await originalSend(request);
      inFlightCount -= 1;
      return result;
    };

    const engine = new SyncEngine(store, store, transport);
    await engine.runOnce();

    expect(maxConcurrent).toBe(1);
  });
});

describe('SyncEngine.runOnce — retry limit exhaustion (RetryPolicy.shouldRetry actually enforced)', () => {
  const smallLimitConfig: RetryPolicyConfig = { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 30_000 };

  it('finalizes an item to FAILED_TERMINAL, in the same run, once a failure pushes it past maxAttempts — and never sends it again', async () => {
    // Starts with 1 attempt already recorded and its retry window already
    // elapsed, so it's selected and dispatched this run; the dispatch
    // fails retryably, bringing attempts to 2 == maxAttempts.
    const item = makeItem({
      id: 'A',
      status: 'FAILED_RETRYABLE',
      attempts: 1,
      nextAttemptAt: '2026-08-22T08:00:00.000Z', // in the past relative to FIXED_NOW below
    });
    const store = new InMemoryOutboxStore([item]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 503 } },
    });
    const engine = new SyncEngine(
      store,
      store,
      transport,
      () => '2026-08-22T09:00:00.000Z',
      smallLimitConfig,
    );

    const summary = await engine.runOnce();

    expect(transport.calls).toHaveLength(1); // dispatched exactly once, then finalized — never sent again
    expect(summary.retryableFailures).toBe(1); // the dispatch attempt itself still failed retryably
    expect(summary.retryLimitExceeded).toBe(1); // ...and was then finalized within this same run
    expect(store.getStatus('A')).toBe('FAILED_TERMINAL');

    const finalItems = await store.listAll();
    const finalItem = finalItems.find((i) => i.id === 'A');
    expect(finalItem?.lastError?.kind).toBe('terminal');
    expect(finalItem?.lastError && 'reason' in finalItem.lastError ? finalItem.lastError.reason : null).toBe(
      'RETRY_LIMIT_EXCEEDED',
    );

    // A subsequent run must not touch it again.
    const secondSummary = await engine.runOnce();
    expect(transport.calls).toHaveLength(1);
    expect(secondSummary.attempted).toBe(0);
    expect(secondSummary.retryLimitExceeded).toBe(0);
  });

  it('finalizes an already-exhausted item before any dispatch is attempted, without calling the transport', async () => {
    const item = makeItem({ id: 'A', status: 'FAILED_RETRYABLE', attempts: 2, nextAttemptAt: null });
    const store = new InMemoryOutboxStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport, undefined, smallLimitConfig);

    const summary = await engine.runOnce();

    expect(transport.calls).toHaveLength(0);
    expect(summary.attempted).toBe(0);
    expect(summary.retryLimitExceeded).toBe(1);
    expect(store.getStatus('A')).toBe('FAILED_TERMINAL');
  });

  it('never exhausts a still-under-budget FAILED_RETRYABLE item, and keeps dispatching it normally', async () => {
    const item = makeItem({ id: 'A', status: 'FAILED_RETRYABLE', attempts: 1, nextAttemptAt: null });
    const store = new InMemoryOutboxStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport, undefined, smallLimitConfig);

    const summary = await engine.runOnce();

    expect(transport.calls).toHaveLength(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.retryLimitExceeded).toBe(0);
    expect(store.getStatus('A')).toBe('SYNCED');
  });

  it('respects DEFAULT_RETRY_POLICY_CONFIG.maxAttempts (5) when no config is supplied to the constructor', async () => {
    const item = makeItem({ id: 'A', status: 'FAILED_RETRYABLE', attempts: 5, nextAttemptAt: null });
    const store = new InMemoryOutboxStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });
    const engine = new SyncEngine(store, store, transport); // no config override

    const summary = await engine.runOnce();

    expect(transport.calls).toHaveLength(0);
    expect(summary.retryLimitExceeded).toBe(1);
    expect(store.getStatus('A')).toBe('FAILED_TERMINAL');
  });
});
