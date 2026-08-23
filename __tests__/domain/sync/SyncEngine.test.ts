import { SyncEngine } from '../../../src/domain/sync/SyncEngine';
import { asIdempotencyKey, type OutboxItem, type OutboxStatus } from '../../../src/domain/sync/OutboxItem';
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
