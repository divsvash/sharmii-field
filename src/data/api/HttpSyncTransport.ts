import type {
  SyncTransport,
  SyncTransportRequest,
  SyncTransportResult,
} from '../../domain/sync/SyncTransport';

export interface HttpSyncTransportOptions {
  /** Base URL of the sync API, e.g. 'https://api.example.com'. No trailing slash. */
  readonly baseUrl: string;
  /** Injectable for tests; defaults to the platform's global fetch (Node 18+, and React Native/Expo both already provide one — no Axios or extra HTTP library needed). */
  readonly fetchFn?: typeof fetch;
  /** Per-request timeout in milliseconds, enforced via AbortController. Default 30s. */
  readonly timeoutMs?: number;
}

/**
 * Production SyncTransport implementation. Its ONLY job is to perform one
 * HTTP request and translate the outcome into the transport's normalized
 * SyncTransportResult shape:
 *   - 2xx                      -> { outcome: 'success' }
 *   - any other HTTP response  -> { outcome: 'failure', signal: { kind: 'httpStatus', status } }
 *   - request aborted (timeout)-> { outcome: 'failure', signal: { kind: 'network', reason: 'TIMEOUT' } }
 *   - any other fetch rejection-> { outcome: 'failure', signal: { kind: 'network', reason: 'UNAVAILABLE' } }
 *
 * This class NEVER decides retryable vs terminal. Classifying an httpStatus
 * or network signal into RETRYABLE/TERMINAL is exactly SyncFailureClassifier's
 * job (domain/sync/SyncFailureClassifier.ts), and its documented mapping —
 * 408/429/5xx retryable, 400/401/403/404 terminal — already matches what
 * this phase's spec requires without this class duplicating a single line
 * of that logic. Any request-timeout use of setTimeout here is an HTTP
 * request timeout, not sync retry scheduling — the frozen dispatcher/engine
 * remain the only things that ever decide retry timing, and they still
 * never use a timer.
 */
export class HttpSyncTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpSyncTransportOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async send(request: SyncTransportRequest): Promise<SyncTransportResult> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': request.idempotencyKey,
        },
        body: JSON.stringify({
          operation: request.operation,
          entityId: request.entityId,
          idempotencyKey: request.idempotencyKey,
          payload: request.payload,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        return { outcome: 'success' };
      }

      return { outcome: 'failure', signal: { kind: 'httpStatus', status: response.status } };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { outcome: 'failure', signal: { kind: 'network', reason: 'TIMEOUT' } };
      }
      // Any other fetch-level rejection (DNS failure, connection refused,
      // TLS error, offline, etc.) is bucketed as "network unavailable" --
      // fetch gives no structured way to distinguish these further, and
      // guessing a more specific reason would be worse than one honest,
      // broad bucket that SyncFailureClassifier already knows is retryable.
      return { outcome: 'failure', signal: { kind: 'network', reason: 'UNAVAILABLE' } };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
