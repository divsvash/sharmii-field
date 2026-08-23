import type { SyncError } from './SyncError';

/**
 * Invariant 2: every mutation gets a client-generated idempotency key.
 * Branded string so a plain `string` can't be passed where an idempotency
 * key is required without an explicit cast — cheap protection against
 * accidentally wiring the wrong id into enqueue().
 */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

export function asIdempotencyKey(value: string): IdempotencyKey {
  if (value.length === 0) {
    throw new Error('IdempotencyKey must not be empty');
  }
  return value as IdempotencyKey;
}

export type OutboxOperation =
  | 'PUNCH_IN'
  | 'PUNCH_OUT'
  | 'INCIDENT_CREATE'
  | 'INCIDENT_PHOTO_UPLOAD';

export type OutboxStatus =
  | 'PENDING' // durably persisted, never attempted
  | 'IN_FLIGHT' // sync engine currently attempting this item
  | 'FAILED_RETRYABLE' // last attempt failed with a retryable SyncError
  | 'FAILED_TERMINAL' // last attempt failed with a terminal SyncError — will not be retried automatically
  | 'SYNCED'; // server has durably accepted this item

/**
 * A durable unit of sync work. One row per mutation that must reach the
 * server — never a batch, so idempotency and dependency ordering apply at
 * the same granularity the server sees.
 */
export interface OutboxItem {
  readonly id: string;
  readonly operation: OutboxOperation;
  /** Local id of the punch / incident / incident photo this item syncs. */
  readonly entityId: string;
  readonly idempotencyKey: IdempotencyKey;
  /**
   * Invariants 3 & 4: punch-out cannot sync before punch-in, incident photos
   * cannot sync before their incident. Null means "no ordering dependency".
   */
  readonly dependsOnOutboxId: string | null;
  /** JSON-serializable snapshot of the data the API call needs. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly lastError: SyncError | null;
  /**
   * ISO8601 timestamp before which this item must not be re-attempted, or
   * null if there's no scheduling constraint (never failed yet, or was
   * just recovered from an abandoned IN_FLIGHT state). Only meaningful
   * while status is FAILED_RETRYABLE — ignored otherwise. Computed by
   * OutboxDispatcher from RetryPolicy.nextDelayMs() when a retryable
   * failure occurs; RetryPolicy itself never persists anything.
   */
  readonly nextAttemptAt: string | null;
  readonly createdAt: string; // ISO8601
  readonly updatedAt: string; // ISO8601
}

/** Shape required to create a new outbox item; server-assigned/derived fields are excluded. */
export type NewOutboxItem = Omit<
  OutboxItem,
  'status' | 'attempts' | 'lastError' | 'nextAttemptAt' | 'updatedAt'
>;

export function isTerminalStatus(status: OutboxStatus): boolean {
  return status === 'SYNCED' || status === 'FAILED_TERMINAL';
}

export function isSyncable(status: OutboxStatus): boolean {
  return status === 'PENDING' || status === 'FAILED_RETRYABLE';
}
