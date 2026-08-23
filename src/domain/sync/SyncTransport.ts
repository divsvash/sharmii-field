import type { IdempotencyKey, OutboxOperation } from './OutboxItem';
import type { SyncFailureSignal } from './SyncFailureClassifier';

/**
 * Exactly what a future API client needs to send one outbox item over the
 * wire: which operation, which local entity it corresponds to, its
 * idempotency key (unchanged, see OutboxDispatcher.ts), and the payload
 * snapshot captured when the item was enqueued. Nothing about attempts,
 * timestamps, or dependency state — the transport doesn't need to know
 * about outbox bookkeeping, only about the request itself.
 */
export interface SyncTransportRequest {
  readonly operation: OutboxOperation;
  readonly entityId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Normalized outcome of one transport attempt. On failure, `signal` is
 * exactly the input SyncFailureClassifier.classifySyncFailure already
 * knows how to consume — the transport's job is to translate whatever a
 * concrete implementation (HTTP, mock, anything) produced into one of
 * these signals; classification itself stays centralized in the
 * classifier, not duplicated per transport.
 */
export type SyncTransportResult =
  | { readonly outcome: 'success' }
  | { readonly outcome: 'failure'; readonly signal: SyncFailureSignal };

/**
 * The transport boundary. Deliberately one method — no connection
 * management, no retries, no batching. A real implementation (HTTP client
 * against the future API, or a mock server for tests) lives in data/ or
 * a future api/ module, entirely outside domain/sync.
 */
export interface SyncTransport {
  send(request: SyncTransportRequest): Promise<SyncTransportResult>;
}
