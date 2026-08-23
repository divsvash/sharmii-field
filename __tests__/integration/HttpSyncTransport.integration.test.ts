import { HttpSyncTransport } from '../../src/data/api/HttpSyncTransport';
import { classifySyncFailure } from '../../src/domain/sync/SyncFailureClassifier';
import { asIdempotencyKey } from '../../src/domain/sync/OutboxItem';
import type { SyncTransportRequest } from '../../src/domain/sync/SyncTransport';
import { MockApiServer } from '../helpers/MockApiServer';

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

  it('idempotency: request #1 and request #2 with the same key both reach the server carrying that exact key', async () => {
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
});
