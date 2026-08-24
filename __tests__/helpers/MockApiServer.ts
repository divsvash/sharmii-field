import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
  /**
   * True if this request was NOT actually applied — it arrived carrying
   * an Idempotency-Key already recorded (by a prior successful response)
   * in the dedup ledger, so the server replayed that earlier response
   * instead of re-running anything. Always false unless
   * enableIdempotencyDedup() has been called. See that method's doc for
   * what this is (and deliberately is not) a stand-in for.
   */
  readonly deduped: boolean;
}

interface QueuedResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly networkFailure?: boolean;
}

/**
 * The smallest possible test-only HTTP server: Node's built-in `http`
 * module, no Express/Fastify/framework of any kind. Exists purely so
 * integration tests can prove HttpSyncTransport and SyncEngine work
 * against a real socket, not a mocked fetch. Not shipped — lives entirely
 * under __tests__.
 *
 * Idempotency dedup (opt-in, off by default — see enableIdempotencyDedup)
 * exists specifically to let a test prove the other half of this
 * codebase's core crash-recovery guarantee. Client-side, the guarantee is
 * "a retry after an uncertain outcome reuses the exact same idempotency
 * key" — that half is real production behavior, exercised elsewhere
 * without needing this. But whether reusing that key actually *prevents
 * a duplicate mutation* is a server-side property this codebase has no
 * server to provide. Without dedup enabled, this class cannot tell two
 * requests apart by key at all — which is itself the honest baseline: a
 * test against it can show that a retry produces a second real
 * application, exactly as it would against no dedup logic whatsoever.
 * Enabling dedup turns this into the minimal server-side behavior a real
 * backend implementing the client's contract would need, so a test can
 * show the alternative: the same retry produces no second application.
 */
export class MockApiServer {
  private readonly server: http.Server;
  private readonly queue: QueuedResponse[] = [];
  private defaultResponse: QueuedResponse = { status: 200 };
  private idempotencyDedupEnabled = false;
  /** Idempotency-Key -> the response it was first, successfully applied with. Only ever populated while dedup is enabled. */
  private readonly appliedResponses = new Map<string, QueuedResponse>();
  private appliedCount = 0;
  readonly requests: RecordedRequest[] = [];

  private constructor(server: http.Server) {
    this.server = server;
  }

  static async start(): Promise<MockApiServer> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const instance = new MockApiServer(server);

      server.on('request', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          let parsedBody: unknown = null;
          try {
            parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null;
          } catch {
            parsedBody = rawBody;
          }

          const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

          // Dedup check happens BEFORE touching the response queue: a
          // real server wouldn't re-run whatever business logic decides
          // the next outcome for a mutation it already applied, so a
          // deduped request must not consume a queued response either —
          // that queue slot is still there for the next genuinely-new key.
          if (instance.idempotencyDedupEnabled && idempotencyKey && instance.appliedResponses.has(idempotencyKey)) {
            const cached = instance.appliedResponses.get(idempotencyKey);
            /* istanbul ignore next -- has() just confirmed presence */
            const replay = cached ?? { status: 200 };
            instance.requests.push({ method: req.method, url: req.url, idempotencyKey, body: parsedBody, deduped: true });
            res.statusCode = replay.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(replay.body !== undefined ? JSON.stringify(replay.body) : '{}');
            return;
          }

          instance.requests.push({ method: req.method, url: req.url, idempotencyKey, body: parsedBody, deduped: false });

          const next = instance.queue.shift() ?? instance.defaultResponse;

          if (next.networkFailure) {
            // Destroy the raw socket instead of writing any HTTP
            // response, so the client's fetch sees a genuine
            // connection-level failure rather than an HTTP status.
            // Nothing was committed, so this key is deliberately never
            // recorded into the dedup ledger — a retry after a network
            // failure should behave as a fresh, first attempt.
            req.socket.destroy();
            return;
          }

          const wasApplied = next.status >= 200 && next.status < 300;
          if (wasApplied) {
            instance.appliedCount += 1;
            if (instance.idempotencyDedupEnabled && idempotencyKey) {
              instance.appliedResponses.set(idempotencyKey, next);
            }
          }

          res.statusCode = next.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(next.body !== undefined ? JSON.stringify(next.body) : '{}');
        });
      });

      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(instance));
    });
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  /** Queues one response, consumed by the next incoming request that isn't itself a deduped replay (in order). */
  queueResponse(status: number, body?: unknown): void {
    this.queue.push({ status, body });
  }

  /** Sets the response used for any request once the queue is empty. */
  setDefaultResponse(status: number, body?: unknown): void {
    this.defaultResponse = { status, body };
  }

  /** Destroys the connection for the next request instead of responding, simulating a network failure rather than any HTTP response. */
  simulateNetworkFailureOnNextRequest(): void {
    this.queue.push({ status: 0, networkFailure: true });
  }

  /**
   * Opts into idempotency-key dedup: once a request carrying a given
   * Idempotency-Key header receives a successful (2xx) response, any
   * later request carrying that same key is replayed from the recorded
   * response instead of consuming the queue or counting as newly applied
   * — see the class doc for what this does and doesn't prove. Off by
   * default because most tests here are about the client's behavior and
   * don't need (or want) server-side dedup complicating the response
   * sequence they've queued up.
   */
  enableIdempotencyDedup(): void {
    this.idempotencyDedupEnabled = true;
  }

  /**
   * How many requests resulted in a genuinely new application — i.e. were
   * NOT served from the idempotency-dedup cache. With dedup disabled,
   * this simply counts every successful (2xx) response, which is the
   * point: it lets a test show that count growing with every retry of
   * the same key (no protection). With dedup enabled, it lets a test show
   * the count staying at 1 across retries of the same key (protected).
   */
  get appliedMutationCount(): number {
    return this.appliedCount;
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
