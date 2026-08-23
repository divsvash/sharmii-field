import {
  asIdempotencyKey,
  isSyncable,
  isTerminalStatus,
} from '../../../src/domain/sync/OutboxItem';

describe('asIdempotencyKey', () => {
  it('rejects an empty string (invariant 2 requires a real key)', () => {
    expect(() => asIdempotencyKey('')).toThrow();
  });

  it('accepts a non-empty string', () => {
    expect(() => asIdempotencyKey('uuid-123')).not.toThrow();
  });
});

describe('outbox status predicates', () => {
  it('classifies SYNCED and FAILED_TERMINAL as terminal', () => {
    expect(isTerminalStatus('SYNCED')).toBe(true);
    expect(isTerminalStatus('FAILED_TERMINAL')).toBe(true);
    expect(isTerminalStatus('PENDING')).toBe(false);
    expect(isTerminalStatus('IN_FLIGHT')).toBe(false);
    expect(isTerminalStatus('FAILED_RETRYABLE')).toBe(false);
  });

  it('classifies PENDING and FAILED_RETRYABLE as syncable', () => {
    expect(isSyncable('PENDING')).toBe(true);
    expect(isSyncable('FAILED_RETRYABLE')).toBe(true);
    expect(isSyncable('IN_FLIGHT')).toBe(false);
    expect(isSyncable('FAILED_TERMINAL')).toBe(false);
    expect(isSyncable('SYNCED')).toBe(false);
  });
});
