import { isSyncable, type OutboxItem, type OutboxStatus } from './OutboxItem';
import type { OutboxDispatchStore } from './OutboxDispatchStore';
import { classifySyncFailure } from './SyncFailureClassifier';
import { DEFAULT_RETRY_POLICY_CONFIG, nextDelayMs, type RetryPolicyConfig } from './RetryPolicy';
import type { SyncError } from './SyncError';
import type { SyncTransport } from './SyncTransport';

/**
 * Outcome of one dispatch call. Every non-NOT_ELIGIBLE, non-CLAIM_FAILED
 * arm corresponds to a state transition that has already been written to
 * `store` by the time this resolves — the caller doesn't need to persist
 * anything further for this attempt.
 */
export type DispatchOutcome =
  | { readonly outcome: 'SYNCED' }
  | { readonly outcome: 'FAILED_RETRYABLE'; readonly error: SyncError; readonly nextAttemptAt: string }
  | { readonly outcome: 'FAILED_TERMINAL'; readonly error: SyncError }
  /** tryClaim returned false — another worker already owns this item. No transport request was sent. */
  | { readonly outcome: 'CLAIM_FAILED' }
  /** item.status wasn't PENDING/FAILED_RETRYABLE. No claim was attempted and no transport request was sent. */
  | { readonly outcome: 'NOT_ELIGIBLE'; readonly status: OutboxStatus };

/** ISO8601 timestamp `delayMs` milliseconds after ISO8601 timestamp `nowIso`. */
function addDelay(nowIso: string, delayMs: number): string {
  return new Date(new Date(nowIso).getTime() + delayMs).toISOString();
}

/**
 * Dispatches exactly one already-selected, eligible OutboxItem:
 *
 *   PENDING / FAILED_RETRYABLE
 *             |
 *         tryClaim()  --false--> CLAIM_FAILED (no transport call)
 *             | true (item is now IN_FLIGHT in the store)
 *       transport.send()
 *          |        |
 *      success    failure
 *          |        |
 *       SYNCED   classifySyncFailure()
 *                    |
 *              RETRYABLE / TERMINAL
 *                    |
 *   nextDelayMs() -> nextAttemptAt   (RETRYABLE only)
 *                    |
 *         FAILED_RETRYABLE / FAILED_TERMINAL
 *
 * Deliberately does NOT decide *whether* another attempt is permitted at
 * all (RetryPolicy.shouldRetry / maxAttempts is a selection-time/caller
 * concern, not this function's), does NOT select which item to dispatch
 * (OutboxDispatchSelector owns that — including rejecting an item whose
 * nextAttemptAt hasn't elapsed yet), does NOT sleep or schedule any timer,
 * and does NOT handle process death — an item that dies while IN_FLIGHT
 * is the startup recovery mechanism's job (OutboxRepository.
 * recoverInFlightItems), not this function's. This function's only new
 * responsibility for retry timing is computing *when* the next attempt
 * becomes eligible (via the frozen, unmodified RetryPolicy.nextDelayMs)
 * and persisting that single timestamp — never a scheduler, never a timer.
 * The item's idempotencyKey is read once from `item` and passed to the
 * transport unchanged; nothing here ever generates a new one.
 */
export async function dispatchOutboxItem(
  item: OutboxItem,
  transport: SyncTransport,
  store: OutboxDispatchStore,
  now: () => string = () => new Date().toISOString(),
  retryPolicyConfig: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
): Promise<DispatchOutcome> {
  if (!isSyncable(item.status)) {
    return { outcome: 'NOT_ELIGIBLE', status: item.status };
  }

  const claimed = await store.tryClaim(item.id);
  if (!claimed) {
    return { outcome: 'CLAIM_FAILED' };
  }

  const result = await transport.send({
    operation: item.operation,
    entityId: item.entityId,
    idempotencyKey: item.idempotencyKey,
    payload: item.payload,
  });

  if (result.outcome === 'success') {
    await store.markSynced(item.id);
    return { outcome: 'SYNCED' };
  }

  const classification = classifySyncFailure(result.signal, now());

  switch (classification.classification) {
    case 'RETRYABLE': {
      // attempts increments as part of markFailed's persistence; the
      // delay is computed against the attempt count this failure produces
      // (item.attempts + 1), matching RetryPolicy's documented "attempt"
      // semantics (number of attempts already made).
      const delayMs = nextDelayMs(item.attempts + 1, retryPolicyConfig);
      const nextAttemptAt = addDelay(now(), delayMs);
      await store.markFailed(item.id, classification.error, 'FAILED_RETRYABLE', nextAttemptAt);
      return { outcome: 'FAILED_RETRYABLE', error: classification.error, nextAttemptAt };
    }

    case 'TERMINAL':
      await store.markFailed(item.id, classification.error, 'FAILED_TERMINAL', null);
      return { outcome: 'FAILED_TERMINAL', error: classification.error };

    case 'SUCCESS': {
      // Contract violation, not a reachable business state: the transport
      // reported outcome:'failure' but attached a signal that classifies
      // as success (e.g. an httpStatus in the 2xx range). Treated as
      // terminal -- not retried blindly -- so a malformed transport can't
      // wedge an item into an infinite retry loop.
      const contractViolation: SyncError = {
        kind: 'terminal',
        reason: 'UNCLASSIFIED',
        message: "Transport reported outcome:'failure' but its signal classified as SUCCESS",
        occurredAt: now(),
      };
      await store.markFailed(item.id, contractViolation, 'FAILED_TERMINAL', null);
      return { outcome: 'FAILED_TERMINAL', error: contractViolation };
    }
  }
}
