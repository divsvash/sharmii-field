import {
  deserializeSyncError,
  isRetryable,
  isTerminal,
  serializeSyncError,
  type SyncError,
} from '../../../src/domain/sync/SyncError';

describe('SyncError classification', () => {
  it('narrows retryable errors distinctly from terminal ones (invariant 5)', () => {
    const retryable: SyncError = {
      kind: 'retryable',
      reason: 'NETWORK_UNREACHABLE',
      message: 'fetch failed',
      occurredAt: '2026-08-18T10:00:00.000Z',
    };
    const terminal: SyncError = {
      kind: 'terminal',
      reason: 'VALIDATION_REJECTED',
      message: 'invalid payload',
      occurredAt: '2026-08-18T10:00:00.000Z',
    };

    expect(isRetryable(retryable)).toBe(true);
    expect(isTerminal(retryable)).toBe(false);
    expect(isRetryable(terminal)).toBe(false);
    expect(isTerminal(terminal)).toBe(true);
  });

  it('round-trips through serialize/deserialize', () => {
    const original: SyncError = {
      kind: 'retryable',
      reason: 'SERVER_UNAVAILABLE',
      message: '503 from server',
      occurredAt: '2026-08-18T10:00:00.000Z',
    };

    const roundTripped = deserializeSyncError(serializeSyncError(original));

    expect(roundTripped).toEqual(original);
  });

  it('rejects corrupt persisted error payloads', () => {
    expect(() => deserializeSyncError('{"kind":"retryable"}')).toThrow();
    expect(() => deserializeSyncError('not json at all')).toThrow();
  });
});
