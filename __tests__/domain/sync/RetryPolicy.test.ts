import {
  DEFAULT_RETRY_POLICY_CONFIG,
  nextDelayMs,
  shouldRetry,
  type RetryPolicyConfig,
} from '../../../src/domain/sync/RetryPolicy';

describe('shouldRetry', () => {
  it('returns true while attempts remain under the default max', () => {
    expect(shouldRetry(1)).toBe(true);
    expect(shouldRetry(4)).toBe(true);
  });

  it('returns false once attempts reach the configured max (max-attempt behavior)', () => {
    expect(shouldRetry(DEFAULT_RETRY_POLICY_CONFIG.maxAttempts)).toBe(false);
    expect(shouldRetry(DEFAULT_RETRY_POLICY_CONFIG.maxAttempts + 1)).toBe(false);
  });

  it('respects a custom maxAttempts', () => {
    const config: RetryPolicyConfig = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 };

    expect(shouldRetry(1, config)).toBe(true);
    expect(shouldRetry(2, config)).toBe(false);
  });

  it('is a pure function of (attempt, config) — no hidden state', () => {
    const config: RetryPolicyConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

    expect(shouldRetry(2, config)).toBe(shouldRetry(2, config));
  });
});

describe('nextDelayMs — exponential growth and cap', () => {
  const config: RetryPolicyConfig = { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 30_000 };

  it('grows exponentially: base, base*2, base*4, base*8, ...', () => {
    expect(nextDelayMs(1, config)).toBe(1000);
    expect(nextDelayMs(2, config)).toBe(2000);
    expect(nextDelayMs(3, config)).toBe(4000);
    expect(nextDelayMs(4, config)).toBe(8000);
    expect(nextDelayMs(5, config)).toBe(16_000);
  });

  it('caps the delay at maxDelayMs and never exceeds it', () => {
    expect(nextDelayMs(6, config)).toBe(30_000); // uncapped would be 32000
    expect(nextDelayMs(10, config)).toBe(30_000); // uncapped would be far larger
  });

  it('rejects an attempt below 1', () => {
    expect(() => nextDelayMs(0, config)).toThrow();
    expect(() => nextDelayMs(-1, config)).toThrow();
  });

  it('uses the default config when none is supplied', () => {
    expect(nextDelayMs(1)).toBe(DEFAULT_RETRY_POLICY_CONFIG.baseDelayMs);
  });
});

describe('nextDelayMs — determinism', () => {
  const config: RetryPolicyConfig = { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 30_000 };

  it('returns the identical value for the identical (attempt, config) with no jitter configured', () => {
    expect(nextDelayMs(3, config)).toBe(nextDelayMs(3, config));
  });

  it('does not use setTimeout, Math.random, or any timer internally when jitter is unset', () => {
    const originalRandom = Math.random;
    let randomCalled = false;
    Math.random = () => {
      randomCalled = true;
      return originalRandom();
    };

    try {
      nextDelayMs(3, config);
      expect(randomCalled).toBe(false);
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe('nextDelayMs — deterministic jitter', () => {
  const config: RetryPolicyConfig = {
    maxAttempts: 10,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitterRatio: 0.5,
  };

  it('applies zero offset when the injected random source returns 0.5 (jitter midpoint)', () => {
    // randomSource() * 2 - 1 = 0 at 0.5, so this should equal the uncapped/unjittered value.
    expect(nextDelayMs(2, config, () => 0.5)).toBe(2000);
  });

  it('applies the maximum negative offset when the injected random source returns 0', () => {
    // attempt 2 -> capped 2000; jitterRange = 2000*0.5 = 1000; offset = (0*2-1)*1000 = -1000
    expect(nextDelayMs(2, config, () => 0)).toBe(1000);
  });

  it('applies the maximum positive offset when the injected random source returns 1', () => {
    // offset = (1*2-1)*1000 = +1000
    expect(nextDelayMs(2, config, () => 1)).toBe(3000);
  });

  it('never returns a jittered delay above maxDelayMs even at the high end of the range', () => {
    const nearCapConfig: RetryPolicyConfig = {
      maxAttempts: 10,
      baseDelayMs: 20_000,
      maxDelayMs: 25_000,
      jitterRatio: 0.5,
    };
    // attempt 1 -> capped 20000 (base < cap); jitterRange = 10000; max offset = +10000 -> 30000, must clamp to 25000
    expect(nextDelayMs(1, nearCapConfig, () => 1)).toBe(25_000);
  });

  it('never returns a negative delay even at the low end of the range', () => {
    const smallBaseConfig: RetryPolicyConfig = {
      maxAttempts: 10,
      baseDelayMs: 100,
      maxDelayMs: 30_000,
      jitterRatio: 1, // full range, so min offset could go to -100
    };
    expect(nextDelayMs(1, smallBaseConfig, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it('produces identical output for identical injected random values (deterministic under test)', () => {
    const fixedRandom = () => 0.37;
    expect(nextDelayMs(3, config, fixedRandom)).toBe(nextDelayMs(3, config, fixedRandom));
  });

  it('is unaffected by jitter when jitterRatio is 0 or omitted', () => {
    const noJitterConfig: RetryPolicyConfig = { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 30_000, jitterRatio: 0 };
    // Even a "random" source that would otherwise shift the value has no effect.
    expect(nextDelayMs(2, noJitterConfig, () => 1)).toBe(2000);
  });
});
