import { HttpSyncTransport } from '../../src/data/api/HttpSyncTransport';
import { classifySyncFailure } from '../../src/domain/sync/SyncFailureClassifier';
import { asIdempotencyKey } from '../../src/domain/sync/OutboxItem';
import type { SyncTransportRequest } from '../../src/domain/sync/SyncTransport';
import { MockApiServer } from '../helpers/MockApiServer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function makeRequest(overrides: Partial<SyncTransportRequest> = {}): SyncTransportRequest {
  return {
    operation: 'PUNCH_IN',
    entityId: 'punch-1',
    idempotencyKey: asIdempotencyKey('idem-1'),
    payload: { punchId: 'punch-1' },
    ...overrides,
  };
}

describe('HttpSyncTransport against a real (test-only) HTTP server', () => {
  let server: MockApiServer;
  let transport: HttpSyncTransport;

  beforeEach(async () => {
    server = await MockApiServer.start();
    transport = new HttpSyncTransport({ baseUrl: server.baseUrl });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('reports success for a real 200 response', async () => {
    server.queueResponse(200, { ok: true });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'success' });
    expect(server.requests).toHaveLength(1);
  });

  it('reports a failure with httpStatus 500, which the classifier then marks retryable', async () => {
    server.queueResponse(500, { error: 'internal server error' });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'failure', signal: { kind: 'httpStatus', status: 500 } });

    if (result.outcome === 'failure') {
      const classified = classifySyncFailure(result.signal, '2026-08-23T09:00:00.000Z');
      expect(classified.classification).toBe('RETRYABLE');
    }
  });

  it('reports a failure with httpStatus 429, which the classifier then marks retryable', async () => {
    server.queueResponse(429, { error: 'rate limited' });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'failure', signal: { kind: 'httpStatus', status: 429 } });
    if (result.outcome === 'failure') {
      const classified = classifySyncFailure(result.signal, '2026-08-23T09:00:00.000Z');
      expect(classified.classification).toBe('RETRYABLE');
    }
  });

  it('reports a failure with httpStatus 400, which the classifier then marks terminal', async () => {
    server.queueResponse(400, { error: 'invalid payload' });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'failure', signal: { kind: 'httpStatus', status: 400 } });
    if (result.outcome === 'failure') {
      const classified = classifySyncFailure(result.signal, '2026-08-23T09:00:00.000Z');
      expect(classified.classification).toBe('TERMINAL');
    }
  });

  it('reports a network failure signal when the connection is destroyed mid-request', async () => {
    server.simulateNetworkFailureOnNextRequest();

    const result = await transport.send(makeRequest());

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.signal.kind).toBe('network');
    }
  });

  it('sends the request body containing operation, entityId, and payload to the real server', async () => {
    server.queueResponse(200);

    await transport.send(
      makeRequest({
        operation: 'INCIDENT_CREATE',
        entityId: 'incident-9',
        payload: { category: 'SAFETY', severity: 'HIGH' },
      }),
    );

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.body).toEqual({
      operation: 'INCIDENT_CREATE',
      entityId: 'incident-9',
      idempotencyKey: 'idem-1',
      payload: { category: 'SAFETY', severity: 'HIGH' },
    });
  });

  it('idempotency key is stable across retries — this is the client-side half only: it proves the SAME key is resent, not that a repeat is ever deduplicated server-side (see the dedup tests below for that)', async () => {
    server.queueResponse(500); // request #1 fails
    server.queueResponse(200); // request #2 (a retry) succeeds

    const request = makeRequest({ idempotencyKey: asIdempotencyKey('idem-fixed-across-retries') });

    const firstResult = await transport.send(request);
    const secondResult = await transport.send(request);

    expect(firstResult).toEqual({ outcome: 'failure', signal: { kind: 'httpStatus', status: 500 } });
    expect(secondResult).toEqual({ outcome: 'success' });

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.idempotencyKey).toBe('idem-fixed-across-retries');
    expect(server.requests[1]?.idempotencyKey).toBe('idem-fixed-across-retries');
    expect(server.requests[0]?.idempotencyKey).toBe(server.requests[1]?.idempotencyKey);
  });

  describe('idempotency — whether a retried request actually prevents duplicate server-side application', () => {
    it('WITHOUT server-side dedup: retrying the same key after a lost response applies the mutation a second time', async () => {
      // MockApiServer.enableIdempotencyDedup() is deliberately not called
      // here — this is the honest baseline this codebase ships with today:
      // nothing server-side exists to protect against this yet.
      server.queueResponse(200); // request #1: the server applies it...
      server.queueResponse(200); // ...but the client never finds out, and retries

      const request = makeRequest({ idempotencyKey: asIdempotencyKey('idem-crash-before-ack') });

      await transport.send(request); // simulates: applied, but response lost before the client could record it
      await transport.send(request); // simulates: client retries after recovery, same key

      expect(server.appliedMutationCount).toBe(2); // the exact failure this codebase is built to prevent
    });

    it('WITH server-side dedup enabled: retrying the same key after a lost response applies the mutation exactly once', async () => {
      server.enableIdempotencyDedup();
      server.queueResponse(200); // request #1: applied for real

      const request = makeRequest({ idempotencyKey: asIdempotencyKey('idem-crash-before-ack') });

      const firstResult = await transport.send(request); // applied
      const secondResult = await transport.send(request); // client retries after recovery, same key

      expect(firstResult).toEqual({ outcome: 'success' });
      expect(secondResult).toEqual({ outcome: 'success' }); // the retry still succeeds from the client's point of view...
      expect(server.appliedMutationCount).toBe(1); // ...but was never re-applied server-side

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]?.deduped).toBe(false);
      expect(server.requests[1]?.deduped).toBe(true); // the second request was replayed from the ledger, not re-run
    });

    it('a failed application (5xx) is never recorded in the dedup ledger, so a genuine retry after a real failure is still allowed to actually apply', async () => {
      server.enableIdempotencyDedup();
      server.queueResponse(500); // request #1: rejected, nothing applied
      server.queueResponse(200); // request #2 (retry): should be treated as a fresh attempt, not deduped

      const request = makeRequest({ idempotencyKey: asIdempotencyKey('idem-real-failure-then-retry') });

      const firstResult = await transport.send(request);
      const secondResult = await transport.send(request);

      expect(firstResult).toEqual({ outcome: 'failure', signal: { kind: 'httpStatus', status: 500 } });
      expect(secondResult).toEqual({ outcome: 'success' });
      expect(server.appliedMutationCount).toBe(1); // exactly one real application — the retry, not the failure
      expect(server.requests[1]?.deduped).toBe(false); // not a replay — a genuinely new attempt was allowed through
    });
  });
});
