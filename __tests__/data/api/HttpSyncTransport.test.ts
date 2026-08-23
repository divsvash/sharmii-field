import { HttpSyncTransport } from '../../../src/data/api/HttpSyncTransport';
import { asIdempotencyKey } from '../../../src/domain/sync/OutboxItem';
import type { SyncTransportRequest } from '../../../src/domain/sync/SyncTransport';

function makeRequest(overrides: Partial<SyncTransportRequest> = {}): SyncTransportRequest {
  return {
    operation: 'PUNCH_IN',
    entityId: 'punch-1',
    idempotencyKey: asIdempotencyKey('idem-1'),
    payload: { foo: 'bar' },
    ...overrides,
  };
}

function fakeFetchReturning(response: Partial<Response> & { ok: boolean; status: number }): typeof fetch {
  return (async () => response as Response) as unknown as typeof fetch;
}

describe('HttpSyncTransport — success mapping', () => {
  it('maps a 200 response to outcome: success', async () => {
    const transport = new HttpSyncTransport({
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetchReturning({ ok: true, status: 200 }),
    });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'success' });
  });

  it('maps a 201 response to outcome: success', async () => {
    const transport = new HttpSyncTransport({
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetchReturning({ ok: true, status: 201 }),
    });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'success' });
  });
});

describe('HttpSyncTransport — failure mapping (never classifies, only normalizes)', () => {
  it.each([408, 429, 500, 502, 503, 504, 400, 401, 403, 404])(
    'maps HTTP %d to a failure with an httpStatus signal carrying that exact status (classification untouched)',
    async (status) => {
      const transport = new HttpSyncTransport({
        baseUrl: 'https://api.example.com',
        fetchFn: fakeFetchReturning({ ok: false, status }),
      });

      const result = await transport.send(makeRequest());

      expect(result).toEqual({ outcome: 'failure', signal: { kind: 'httpStatus', status } });
    },
  );

  it('maps a fetch rejection (e.g. DNS/connection failure) to a network UNAVAILABLE signal', async () => {
    const throwingFetch: typeof fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const transport = new HttpSyncTransport({ baseUrl: 'https://api.example.com', fetchFn: throwingFetch });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'failure', signal: { kind: 'network', reason: 'UNAVAILABLE' } });
  });

  it('maps an aborted request (timeout) to a network TIMEOUT signal', async () => {
    const abortingFetch: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const transport = new HttpSyncTransport({
      baseUrl: 'https://api.example.com',
      fetchFn: abortingFetch,
      timeoutMs: 5,
    });

    const result = await transport.send(makeRequest());

    expect(result).toEqual({ outcome: 'failure', signal: { kind: 'network', reason: 'TIMEOUT' } });
  });
});

describe('HttpSyncTransport — request contents', () => {
  it('sends operation, entityId, idempotencyKey, and payload in the request body and idempotency header', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const capturingFetch: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const transport = new HttpSyncTransport({ baseUrl: 'https://api.example.com', fetchFn: capturingFetch });

    await transport.send(
      makeRequest({
        operation: 'INCIDENT_PHOTO_UPLOAD',
        entityId: 'photo-42',
        idempotencyKey: asIdempotencyKey('idem-photo-42'),
        payload: { incidentId: 'incident-7' },
      }),
    );

    expect(capturedUrl).toBe('https://api.example.com/sync');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-photo-42');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse((capturedInit?.body ?? '{}') as string)).toEqual({
      operation: 'INCIDENT_PHOTO_UPLOAD',
      entityId: 'photo-42',
      idempotencyKey: 'idem-photo-42',
      payload: { incidentId: 'incident-7' },
    });
  });

  it('sends the exact same idempotency key on a second call for the same request', async () => {
    const capturedKeys: string[] = [];
    const capturingFetch: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      capturedKeys.push(headers['Idempotency-Key'] ?? '');
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const transport = new HttpSyncTransport({ baseUrl: 'https://api.example.com', fetchFn: capturingFetch });
    const request = makeRequest({ idempotencyKey: asIdempotencyKey('idem-fixed') });

    await transport.send(request);
    await transport.send(request);

    expect(capturedKeys).toEqual(['idem-fixed', 'idem-fixed']);
  });
});
