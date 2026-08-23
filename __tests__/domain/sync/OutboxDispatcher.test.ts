import { dispatchOutboxItem } from '../../../src/domain/sync/OutboxDispatcher';
import { asIdempotencyKey, type OutboxItem, type OutboxStatus } from '../../../src/domain/sync/OutboxItem';
import { FakeSyncTransport } from '../../helpers/FakeSyncTransport';
import { InMemoryOutboxDispatchStore } from '../../helpers/InMemoryOutboxDispatchStore';

function makeItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'outbox-1',
    operation: 'PUNCH_IN',
    entityId: 'punch-1',
    idempotencyKey: asIdempotencyKey('idem-outbox-1'),
    dependsOnOutboxId: null,
    payload: { punchId: 'punch-1' },
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: '2026-08-21T09:00:00.000Z',
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

const FIXED_NOW = () => '2026-08-21T10:00:00.000Z';

describe('dispatchOutboxItem — successful dispatch', () => {
  it('transitions PENDING -> IN_FLIGHT -> SYNCED on transport success', async () => {
    const item = makeItem({ status: 'PENDING' });
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result).toEqual({ outcome: 'SYNCED' });
    expect(store.getStatus(item.id)).toBe('SYNCED');
    expect(store.markSyncedCalls).toEqual([item.id]);
  });

  it('also dispatches an item starting from FAILED_RETRYABLE', async () => {
    const item = makeItem({ status: 'FAILED_RETRYABLE', attempts: 2 });
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result).toEqual({ outcome: 'SYNCED' });
    expect(store.getStatus(item.id)).toBe('SYNCED');
  });
});

describe('dispatchOutboxItem — retryable failure', () => {
  it('transitions to FAILED_RETRYABLE and returns the classified error', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 503 } },
    });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result.outcome).toBe('FAILED_RETRYABLE');
    if (result.outcome === 'FAILED_RETRYABLE') {
      expect(result.error.kind).toBe('retryable');
      expect(result.error.reason).toBe('SERVER_UNAVAILABLE');
      expect(result.error.occurredAt).toBe(FIXED_NOW());
      expect(result.nextAttemptAt).toBe('2026-08-21T10:00:01.000Z'); // FIXED_NOW + 1000ms (attempt 1, base delay)
    }
    expect(store.getStatus(item.id)).toBe('FAILED_RETRYABLE');
    expect(store.markFailedCalls).toEqual([
      {
        id: item.id,
        error: expect.objectContaining({ reason: 'SERVER_UNAVAILABLE' }),
        status: 'FAILED_RETRYABLE',
        nextAttemptAt: '2026-08-21T10:00:01.000Z',
      },
    ]);
  });

  it('classifies a network-level failure as retryable', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'network', reason: 'TIMEOUT' } },
    });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result.outcome).toBe('FAILED_RETRYABLE');
    expect(store.getStatus(item.id)).toBe('FAILED_RETRYABLE');
  });
});

describe('dispatchOutboxItem — terminal failure', () => {
  it('transitions to FAILED_TERMINAL and returns the classified error', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 400 } },
    });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result.outcome).toBe('FAILED_TERMINAL');
    if (result.outcome === 'FAILED_TERMINAL') {
      expect(result.error.kind).toBe('terminal');
      expect(result.error.reason).toBe('VALIDATION_REJECTED');
    }
    expect(store.getStatus(item.id)).toBe('FAILED_TERMINAL');
  });

  it('classifies an application-level business-rule rejection as terminal', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'application', reason: 'BUSINESS_RULE_REJECTION' } },
    });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result.outcome).toBe('FAILED_TERMINAL');
    expect(store.getStatus(item.id)).toBe('FAILED_TERMINAL');
  });

  it('treats a transport contract violation (failure outcome with a success-classified signal) as terminal, not a silent retry', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 200 } },
    });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result.outcome).toBe('FAILED_TERMINAL');
    expect(store.getStatus(item.id)).toBe('FAILED_TERMINAL');
  });
});

describe('dispatchOutboxItem — idempotency key preserved across retries', () => {
  it('sends the exact same idempotency key on a second dispatch attempt for the same item', async () => {
    const item = makeItem({ idempotencyKey: asIdempotencyKey('idem-fixed-forever') });
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({
      results: [
        { outcome: 'failure', signal: { kind: 'httpStatus', status: 503 } },
        { outcome: 'success' },
      ],
    });

    const firstAttempt = await dispatchOutboxItem(item, transport, store, FIXED_NOW);
    expect(firstAttempt.outcome).toBe('FAILED_RETRYABLE');
    expect(store.getStatus(item.id)).toBe('FAILED_RETRYABLE'); // claimable again

    const secondAttempt = await dispatchOutboxItem(item, transport, store, FIXED_NOW);
    expect(secondAttempt.outcome).toBe('SYNCED');

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.idempotencyKey).toBe('idem-fixed-forever');
    expect(transport.calls[1]?.idempotencyKey).toBe('idem-fixed-forever');
    expect(transport.calls[0]?.idempotencyKey).toBe(transport.calls[1]?.idempotencyKey);
  });
});

describe('dispatchOutboxItem — conditional claiming', () => {
  it('does not send a transport request when the claim fails', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([item]);
    // Simulate another worker having already claimed it.
    await store.tryClaim(item.id);
    expect(store.getStatus(item.id)).toBe('IN_FLIGHT');

    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result).toEqual({ outcome: 'CLAIM_FAILED' });
    expect(transport.calls).toHaveLength(0);
  });

  it('does not send a transport request when the item no longer exists in the store', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([]); // never registered
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

    const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(result).toEqual({ outcome: 'CLAIM_FAILED' });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('dispatchOutboxItem — only eligible states can be dispatched', () => {
  it.each<OutboxStatus>(['IN_FLIGHT', 'SYNCED', 'FAILED_TERMINAL'])(
    'refuses to dispatch an item with status %s without attempting a claim or transport call',
    async (status) => {
      const item = makeItem({ status });
      const store = new InMemoryOutboxDispatchStore([item]);
      const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

      const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

      expect(result).toEqual({ outcome: 'NOT_ELIGIBLE', status });
      expect(transport.calls).toHaveLength(0);
      // Store state is untouched — status wasn't a claimable one, so
      // tryClaim was never even invoked.
      expect(store.getStatus(item.id)).toBe(status);
    },
  );

  it.each<OutboxStatus>(['PENDING', 'FAILED_RETRYABLE'])(
    'allows dispatch of an item with status %s',
    async (status) => {
      const item = makeItem({ status });
      const store = new InMemoryOutboxDispatchStore([item]);
      const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

      const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

      expect(result).toEqual({ outcome: 'SYNCED' });
      expect(transport.calls).toHaveLength(1);
    },
  );
});

describe('dispatchOutboxItem — transport request contents', () => {
  it('passes operation, entityId, idempotencyKey, and payload through unchanged', async () => {
    const item = makeItem({
      operation: 'INCIDENT_PHOTO_UPLOAD',
      entityId: 'photo-42',
      idempotencyKey: asIdempotencyKey('idem-photo-42'),
      payload: { incidentId: 'incident-7', filePath: 'file:///photo.jpg' },
    });
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

    await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    expect(transport.calls).toEqual([
      {
        operation: 'INCIDENT_PHOTO_UPLOAD',
        entityId: 'photo-42',
        idempotencyKey: 'idem-photo-42',
        payload: { incidentId: 'incident-7', filePath: 'file:///photo.jpg' },
      },
    ]);
  });

  it('does not include attempts, timestamps, or dependency info in the transport request', async () => {
    const item = makeItem({ attempts: 3, dependsOnOutboxId: 'outbox-0' });
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

    await dispatchOutboxItem(item, transport, store, FIXED_NOW);

    const sent = transport.calls[0];
    expect(sent).not.toHaveProperty('attempts');
    expect(sent).not.toHaveProperty('dependsOnOutboxId');
    expect(sent).not.toHaveProperty('createdAt');
  });
});

describe('dispatchOutboxItem — does not sleep or schedule timers', () => {
  it('resolves without needing fake timers advanced, and schedules no timers', async () => {
    jest.useFakeTimers();
    try {
      const item = makeItem();
      const store = new InMemoryOutboxDispatchStore([item]);
      const transport = new FakeSyncTransport({ result: { outcome: 'success' } });

      const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

      expect(result).toEqual({ outcome: 'SYNCED' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not use setTimeout/backoff for a retryable failure either — only classifies and marks', async () => {
    jest.useFakeTimers();
    try {
      const item = makeItem();
      const store = new InMemoryOutboxDispatchStore([item]);
      const transport = new FakeSyncTransport({
        result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 500 } },
      });

      const result = await dispatchOutboxItem(item, transport, store, FIXED_NOW);

      expect(result.outcome).toBe('FAILED_RETRYABLE');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('dispatchOutboxItem — determinism', () => {
  it('uses the injected clock for occurredAt rather than the system clock', async () => {
    const item = makeItem();
    const store = new InMemoryOutboxDispatchStore([item]);
    const transport = new FakeSyncTransport({
      result: { outcome: 'failure', signal: { kind: 'httpStatus', status: 500 } },
    });
    const customTime = '1999-12-31T23:59:59.000Z';

    const result = await dispatchOutboxItem(item, transport, store, () => customTime);

    if (result.outcome === 'FAILED_RETRYABLE') {
      expect(result.error.occurredAt).toBe(customTime);
    } else {
      throw new Error('expected FAILED_RETRYABLE');
    }
  });
});
