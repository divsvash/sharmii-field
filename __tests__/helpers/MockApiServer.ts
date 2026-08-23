import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
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
 */
export class MockApiServer {
  private readonly server: http.Server;
  private readonly queue: QueuedResponse[] = [];
  private defaultResponse: QueuedResponse = { status: 200 };
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

          instance.requests.push({
            method: req.method,
            url: req.url,
            idempotencyKey: req.headers['idempotency-key'] as string | undefined,
            body: parsedBody,
          });

          const next = instance.queue.shift() ?? instance.defaultResponse;

          if (next.networkFailure) {
            // Destroy the raw socket instead of writing any HTTP
            // response, so the client's fetch sees a genuine
            // connection-level failure rather than an HTTP status.
            req.socket.destroy();
            return;
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

  /** Queues one response, consumed by the next incoming request (in order). */
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

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
