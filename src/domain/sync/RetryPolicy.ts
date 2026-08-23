/**
 * Retry SCHEDULING — deliberately separate from failure CLASSIFICATION
 * (see SyncFailureClassifier.ts). This module never decides whether an
 * error is retryable; a caller only consults it after the classifier has
 * already said RETRYABLE. It answers exactly two questions:
 *   - shouldRetry(attempt): give up yet, or try again?
 *   - nextDelayMs(attempt): how long to wait before the next try?
 *
 * `attempt` is the number of attempts already made for this outbox item
 * (i.e. OutboxItem.attempts after the most recent failure — 1 after the
 * first failure, 2 after the second, ...). This module never sleeps or
 * calls setTimeout itself; it only returns a delay in milliseconds. The
 * caller (a future SyncEngine) is responsible for actually waiting.
 */

export interface RetryPolicyConfig {
  /** Once `attempt` reaches this value, shouldRetry returns false. */
  readonly maxAttempts: number;
  /** Delay before the first retry (attempt = 1), before any exponential growth or cap. */
  readonly baseDelayMs: number;
  /** Hard ceiling — no computed delay is ever returned above this. */
  readonly maxDelayMs: number;
  /**
   * Optional jitter as a fraction (0-1) of the capped delay, applied as
   * +/- jitterRatio around the capped value. Omitted or 0 means no
   * jitter — nextDelayMs is then a pure function of `attempt` alone.
   */
  readonly jitterRatio?: number;
}

export const DEFAULT_RETRY_POLICY_CONFIG: RetryPolicyConfig = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/**
 * True while more attempts remain. Pure attempt-count comparison —
 * whether the error itself was retryable or terminal is the classifier's
 * job, not this function's; a terminal error should never even reach here.
 */
export function shouldRetry(attempt: number, config: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG): boolean {
  return attempt < config.maxAttempts;
}

/**
 * Delay in milliseconds before the next attempt, given how many attempts
 * have already been made. Doubles per attempt (base * 2^(attempt-1)),
 * capped at maxDelayMs.
 *
 * Optional deterministic jitter: pass `randomSource` (defaults to
 * Math.random) to inject a fixed value in tests -- e.g. `() => 0.5` for
 * the midpoint of the jitter range, or `() => 0`/`() => 1` for the
 * extremes. Jitter is only applied when config.jitterRatio is set and
 * non-zero; with no jitter configured, nextDelayMs is a pure function of
 * `attempt`.
 */
export function nextDelayMs(
  attempt: number,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
  randomSource: () => number = Math.random,
): number {
  if (attempt < 1) {
    throw new Error(`nextDelayMs: attempt must be >= 1, got ${attempt}`);
  }

  const exponential = config.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, config.maxDelayMs);

  if (!config.jitterRatio) {
    return capped;
  }

  const jitterRange = capped * config.jitterRatio;
  // randomSource() in [0, 1) maps to an offset in [-jitterRange, +jitterRange).
  const offset = (randomSource() * 2 - 1) * jitterRange;
  const jittered = Math.round(capped + offset);

  return Math.max(0, Math.min(config.maxDelayMs, jittered));
}
