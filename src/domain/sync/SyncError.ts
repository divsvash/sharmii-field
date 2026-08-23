/**
 * Invariant 5: Retryable and terminal failures must be represented distinctly.
 *
 * This is a discriminated union rather than an exception hierarchy so that
 * (a) it can be persisted as plain JSON in outbox_items.last_error, and
 * (b) callers are forced by the type system to branch on `kind` before
 *     deciding whether to retry, instead of inspecting error messages.
 */

export type RetryableReason =
  | 'NETWORK_UNREACHABLE'
  | 'REQUEST_TIMEOUT'
  | 'SERVER_UNAVAILABLE' // 5xx
  | 'RATE_LIMITED' // 429
  | 'CONNECTION_RESET'
  | 'PROCESS_INTERRUPTED'; // item was IN_FLIGHT when the app process died; outcome unknown

export type TerminalReason =
  | 'VALIDATION_REJECTED' // 4xx (not 401/403/404) — server says payload/request is invalid
  | 'CONFLICT' // duplicate/idempotency conflict the server refuses to reconcile
  | 'AUTH_REJECTED' // 401/403 that a token refresh could not resolve
  | 'NOT_FOUND' // 404 — the referenced resource does not exist server-side
  | 'BUSINESS_RULE_REJECTED' // request was well-formed but violates a server-side business rule
  | 'INVALID_IDEMPOTENCY_REQUEST' // server rejected the idempotency key/request shape itself
  | 'UNSUPPORTED_OPERATION' // client sent an operation the server no longer accepts
  | 'UNCLASSIFIED'; // failure signal didn't match any known category — treated as terminal out of caution, not as a silent default

export interface RetryableSyncError {
  readonly kind: 'retryable';
  readonly reason: RetryableReason;
  readonly message: string;
  readonly occurredAt: string; // ISO8601
}

export interface TerminalSyncError {
  readonly kind: 'terminal';
  readonly reason: TerminalReason;
  readonly message: string;
  readonly occurredAt: string; // ISO8601
}

export type SyncError = RetryableSyncError | TerminalSyncError;

export function isRetryable(error: SyncError): error is RetryableSyncError {
  return error.kind === 'retryable';
}

export function isTerminal(error: SyncError): error is TerminalSyncError {
  return error.kind === 'terminal';
}

/**
 * Serialization helpers — outbox_items.last_error is stored as TEXT (JSON).
 * Centralized here so no other layer hand-rolls JSON.stringify/parse on
 * SyncError and risks drifting from this shape.
 */
export function serializeSyncError(error: SyncError): string {
  return JSON.stringify(error);
}

export function deserializeSyncError(raw: string): SyncError {
  const parsed: unknown = JSON.parse(raw);
  if (!isValidSyncErrorShape(parsed)) {
    throw new Error(`Corrupt SyncError payload: ${raw}`);
  }
  return parsed;
}

function isValidSyncErrorShape(value: unknown): value is SyncError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === 'retryable' || candidate.kind === 'terminal') &&
    typeof candidate.reason === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.occurredAt === 'string'
  );
}
