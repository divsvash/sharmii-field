import type { RetryableReason, SyncError, TerminalReason } from './SyncError';

/**
 * The three-way outcome the assignment asks for. Deliberately not folded
 * into SyncError itself — SyncError only ever describes a *failure*
 * (invariant 5), and a bare 'SUCCESS' string has no reason/message/time to
 * carry, so giving it its own arm here keeps SyncError's shape unchanged.
 */
export type SyncClassification = 'SUCCESS' | 'RETRYABLE' | 'TERMINAL';

export type SyncClassificationResult =
  | { readonly classification: 'SUCCESS' }
  | { readonly classification: 'RETRYABLE'; readonly error: SyncError & { readonly kind: 'retryable' } }
  | { readonly classification: 'TERMINAL'; readonly error: SyncError & { readonly kind: 'terminal' } };

/**
 * What a future API client translates a raw response/exception into before
 * calling classifySyncFailure. Three kinds, matching how failures actually
 * arrive: an HTTP response with a status code; a network-level failure that
 * never got as far as a status code; or a structured application-level
 * rejection the server returned in its response body. A fourth kind covers
 * anything that doesn't fit — see 'unknown' below.
 */
export type SyncFailureSignal =
  | { readonly kind: 'httpStatus'; readonly status: number }
  | { readonly kind: 'network'; readonly reason: 'UNAVAILABLE' | 'TIMEOUT' | 'CONNECTION_RESET' }
  | {
      readonly kind: 'application';
      readonly reason:
        | 'INVALID_PAYLOAD'
        | 'VALIDATION_FAILURE'
        | 'BUSINESS_RULE_REJECTION'
        | 'INVALID_IDEMPOTENCY_REQUEST';
    }
  /** Anything the caller couldn't map to one of the above — see the 'Do not blindly retry unknown errors' rule. */
  | { readonly kind: 'unknown'; readonly message?: string };

const RETRYABLE_HTTP_STATUS: ReadonlyMap<number, RetryableReason> = new Map([
  [408, 'REQUEST_TIMEOUT'],
  [429, 'RATE_LIMITED'],
  [500, 'SERVER_UNAVAILABLE'],
  [502, 'SERVER_UNAVAILABLE'],
  [503, 'SERVER_UNAVAILABLE'],
  [504, 'SERVER_UNAVAILABLE'],
]);

const TERMINAL_HTTP_STATUS: ReadonlyMap<number, TerminalReason> = new Map([
  [400, 'VALIDATION_REJECTED'],
  [401, 'AUTH_REJECTED'],
  [403, 'AUTH_REJECTED'],
  [404, 'NOT_FOUND'],
]);

const NETWORK_REASON_TO_RETRYABLE: Readonly<Record<'UNAVAILABLE' | 'TIMEOUT' | 'CONNECTION_RESET', RetryableReason>> = {
  UNAVAILABLE: 'NETWORK_UNREACHABLE',
  TIMEOUT: 'REQUEST_TIMEOUT',
  CONNECTION_RESET: 'CONNECTION_RESET',
};

const APPLICATION_REASON_TO_TERMINAL: Readonly<
  Record<
    'INVALID_PAYLOAD' | 'VALIDATION_FAILURE' | 'BUSINESS_RULE_REJECTION' | 'INVALID_IDEMPOTENCY_REQUEST',
    TerminalReason
  >
> = {
  INVALID_PAYLOAD: 'VALIDATION_REJECTED',
  VALIDATION_FAILURE: 'VALIDATION_REJECTED',
  BUSINESS_RULE_REJECTION: 'BUSINESS_RULE_REJECTED',
  INVALID_IDEMPOTENCY_REQUEST: 'INVALID_IDEMPOTENCY_REQUEST',
};

function retryableResult(reason: RetryableReason, message: string, occurredAt: string): SyncClassificationResult {
  return {
    classification: 'RETRYABLE',
    error: { kind: 'retryable', reason, message, occurredAt },
  };
}

function terminalResult(reason: TerminalReason, message: string, occurredAt: string): SyncClassificationResult {
  return {
    classification: 'TERMINAL',
    error: { kind: 'terminal', reason, message, occurredAt },
  };
}

/**
 * HTTP status classification, isolated because it has its own convention
 * for codes the assignment didn't explicitly list: unlisted 5xx defaults
 * to RETRYABLE (a server-side failure, by HTTP convention, is presumed
 * transient); unlisted 4xx and anything else defaults to TERMINAL. This is
 * a documented convention, not a blind "unknown = retry" — see the
 * 'unknown' signal kind below for the genuinely unclassified case.
 */
function classifyHttpStatus(status: number, occurredAt: string): SyncClassificationResult {
  if (status >= 200 && status < 300) {
    return { classification: 'SUCCESS' };
  }

  const retryableReason = RETRYABLE_HTTP_STATUS.get(status);
  if (retryableReason) {
    return retryableResult(retryableReason, `HTTP ${status}`, occurredAt);
  }

  const terminalReason = TERMINAL_HTTP_STATUS.get(status);
  if (terminalReason) {
    return terminalResult(terminalReason, `HTTP ${status}`, occurredAt);
  }

  if (status >= 500 && status < 600) {
    return retryableResult(
      'SERVER_UNAVAILABLE',
      `HTTP ${status} (unlisted 5xx, treated as transient by convention)`,
      occurredAt,
    );
  }

  return terminalResult(
    'UNCLASSIFIED',
    `HTTP ${status} (unlisted status, treated as non-retryable by default)`,
    occurredAt,
  );
}

/**
 * Pure, deterministic classification of a single sync failure signal into
 * SUCCESS / RETRYABLE / TERMINAL. No network access, no timers, no
 * randomness — `occurredAt` is supplied by the caller rather than read
 * from the system clock internally, so this function's output is fully
 * determined by its inputs.
 */
export function classifySyncFailure(signal: SyncFailureSignal, occurredAt: string): SyncClassificationResult {
  switch (signal.kind) {
    case 'httpStatus':
      return classifyHttpStatus(signal.status, occurredAt);

    case 'network':
      return retryableResult(
        NETWORK_REASON_TO_RETRYABLE[signal.reason],
        `network: ${signal.reason}`,
        occurredAt,
      );

    case 'application':
      return terminalResult(
        APPLICATION_REASON_TO_TERMINAL[signal.reason],
        `application: ${signal.reason}`,
        occurredAt,
      );

    case 'unknown':
      // Do not blindly classify unknown errors as retryable — default to
      // TERMINAL, tagged UNCLASSIFIED so it's visibly distinct from a
      // deliberate terminal rejection and easy to find/triage later.
      return terminalResult('UNCLASSIFIED', signal.message ?? 'Unrecognized failure signal', occurredAt);
  }
}
