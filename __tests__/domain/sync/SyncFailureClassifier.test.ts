import { classifySyncFailure, type SyncFailureSignal } from '../../../src/domain/sync/SyncFailureClassifier';

const OCCURRED_AT = '2026-08-20T09:00:00.000Z';

function httpStatus(status: number): SyncFailureSignal {
  return { kind: 'httpStatus', status };
}

describe('classifySyncFailure — HTTP status codes', () => {
  describe('retryable statuses', () => {
    it.each([
      [408, 'REQUEST_TIMEOUT'],
      [429, 'RATE_LIMITED'],
      [500, 'SERVER_UNAVAILABLE'],
      [502, 'SERVER_UNAVAILABLE'],
      [503, 'SERVER_UNAVAILABLE'],
      [504, 'SERVER_UNAVAILABLE'],
    ] as const)('classifies HTTP %d as RETRYABLE with reason %s', (status, reason) => {
      const result = classifySyncFailure(httpStatus(status), OCCURRED_AT);

      expect(result.classification).toBe('RETRYABLE');
      if (result.classification === 'RETRYABLE') {
        expect(result.error.reason).toBe(reason);
        expect(result.error.kind).toBe('retryable');
        expect(result.error.occurredAt).toBe(OCCURRED_AT);
      }
    });
  });

  describe('terminal statuses', () => {
    it.each([
      [400, 'VALIDATION_REJECTED'],
      [401, 'AUTH_REJECTED'],
      [403, 'AUTH_REJECTED'],
      [404, 'NOT_FOUND'],
    ] as const)('classifies HTTP %d as TERMINAL with reason %s', (status, reason) => {
      const result = classifySyncFailure(httpStatus(status), OCCURRED_AT);

      expect(result.classification).toBe('TERMINAL');
      if (result.classification === 'TERMINAL') {
        expect(result.error.reason).toBe(reason);
        expect(result.error.kind).toBe('terminal');
      }
    });
  });

  it('classifies 2xx statuses as SUCCESS', () => {
    for (const status of [200, 201, 204, 299]) {
      expect(classifySyncFailure(httpStatus(status), OCCURRED_AT)).toEqual({ classification: 'SUCCESS' });
    }
  });

  it('treats an unlisted 5xx status as RETRYABLE by convention (not blindly, but documented)', () => {
    const result = classifySyncFailure(httpStatus(501), OCCURRED_AT);

    expect(result.classification).toBe('RETRYABLE');
    if (result.classification === 'RETRYABLE') {
      expect(result.error.reason).toBe('SERVER_UNAVAILABLE');
    }
  });

  it('treats an unlisted 4xx status as TERMINAL, not as a blind retry', () => {
    const result = classifySyncFailure(httpStatus(418), OCCURRED_AT);

    expect(result.classification).toBe('TERMINAL');
    if (result.classification === 'TERMINAL') {
      expect(result.error.reason).toBe('UNCLASSIFIED');
    }
  });

  it('treats an unrecognized non-4xx/5xx status as TERMINAL', () => {
    const result = classifySyncFailure(httpStatus(302), OCCURRED_AT);

    expect(result.classification).toBe('TERMINAL');
    if (result.classification === 'TERMINAL') {
      expect(result.error.reason).toBe('UNCLASSIFIED');
    }
  });
});

describe('classifySyncFailure — network-level failures', () => {
  it.each([
    ['UNAVAILABLE', 'NETWORK_UNREACHABLE'],
    ['TIMEOUT', 'REQUEST_TIMEOUT'],
    ['CONNECTION_RESET', 'CONNECTION_RESET'],
  ] as const)('classifies network reason %s as RETRYABLE with reason %s', (networkReason, expectedReason) => {
    const result = classifySyncFailure({ kind: 'network', reason: networkReason }, OCCURRED_AT);

    expect(result.classification).toBe('RETRYABLE');
    if (result.classification === 'RETRYABLE') {
      expect(result.error.reason).toBe(expectedReason);
    }
  });
});

describe('classifySyncFailure — application-level rejections', () => {
  it.each([
    ['INVALID_PAYLOAD', 'VALIDATION_REJECTED'],
    ['VALIDATION_FAILURE', 'VALIDATION_REJECTED'],
    ['BUSINESS_RULE_REJECTION', 'BUSINESS_RULE_REJECTED'],
    ['INVALID_IDEMPOTENCY_REQUEST', 'INVALID_IDEMPOTENCY_REQUEST'],
  ] as const)('classifies application reason %s as TERMINAL with reason %s', (appReason, expectedReason) => {
    const result = classifySyncFailure({ kind: 'application', reason: appReason }, OCCURRED_AT);

    expect(result.classification).toBe('TERMINAL');
    if (result.classification === 'TERMINAL') {
      expect(result.error.reason).toBe(expectedReason);
    }
  });
});

describe('classifySyncFailure — unknown failures', () => {
  it('does not blindly classify an unknown error as retryable — defaults to TERMINAL/UNCLASSIFIED', () => {
    const result = classifySyncFailure({ kind: 'unknown' }, OCCURRED_AT);

    expect(result.classification).toBe('TERMINAL');
    if (result.classification === 'TERMINAL') {
      expect(result.error.reason).toBe('UNCLASSIFIED');
    }
  });

  it('preserves a supplied message for an unknown failure', () => {
    const result = classifySyncFailure({ kind: 'unknown', message: 'weird proxy error' }, OCCURRED_AT);

    if (result.classification === 'TERMINAL') {
      expect(result.error.message).toBe('weird proxy error');
    } else {
      throw new Error('expected TERMINAL');
    }
  });
});

describe('classifySyncFailure — determinism', () => {
  it('is a pure function: identical input always yields an identical result', () => {
    const signal: SyncFailureSignal = httpStatus(503);

    const first = classifySyncFailure(signal, OCCURRED_AT);
    const second = classifySyncFailure(signal, OCCURRED_AT);

    expect(first).toEqual(second);
  });

  it('never touches the system clock — occurredAt is exactly what the caller passed in', () => {
    const customTimestamp = '1999-01-01T00:00:00.000Z';
    const result = classifySyncFailure(httpStatus(500), customTimestamp);

    if (result.classification === 'RETRYABLE') {
      expect(result.error.occurredAt).toBe(customTimestamp);
    } else {
      throw new Error('expected RETRYABLE');
    }
  });
});
