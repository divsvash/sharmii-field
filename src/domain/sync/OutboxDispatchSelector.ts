import type { OutboxItem, OutboxStatus } from './OutboxItem';
import { isSyncable } from './OutboxItem';
import { DEFAULT_RETRY_POLICY_CONFIG, shouldRetry, type RetryPolicyConfig } from './RetryPolicy';

/**
 * Why an item is or isn't eligible for dispatch right now. This is a
 * derived, in-memory-only classification — it is never persisted and adds
 * no new value to OutboxStatus. The persisted state model (invariant 5:
 * retryable vs terminal are represented distinctly) is left exactly as
 * the frozen foundation defined it; this type exists purely so a caller
 * (a future SyncEngine, or a debug view) can tell two different kinds of
 * "not eligible" apart without the selector silently collapsing them.
 *
 * In particular: a dependent whose prerequisite is FAILED_TERMINAL is
 * BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY, not BLOCKED_ON_DEPENDENCY —
 * the two are distinguishable, and neither one causes this module to
 * write anything. Nothing here ever marks the dependent itself
 * FAILED_TERMINAL; cascading a terminal failure onto dependents is a
 * write decision for whatever component owns OutboxRepository.markFailed,
 * not for a pure selector, and the current domain model has no defined
 * transition for it — so this module deliberately stops at classification.
 *
 * BLOCKED_ON_RETRY_WINDOW is the retry-timing counterpart: a
 * FAILED_RETRYABLE item whose nextAttemptAt (set by OutboxDispatcher via
 * RetryPolicy.nextDelayMs) hasn't elapsed yet. It is checked before
 * dependency status, since an item can't be dispatched early regardless
 * of what its dependency is doing.
 *
 * RETRY_LIMIT_EXCEEDED is checked before BLOCKED_ON_RETRY_WINDOW: an item
 * that has exhausted RetryPolicy.shouldRetry's attempt budget must never
 * become eligible again, regardless of what its nextAttemptAt says. This
 * module still only classifies — it never writes FAILED_TERMINAL itself;
 * see SyncEngine.finalizeExhaustedRetries for the write side.
 */
export type OutboxEligibility =
  | { readonly kind: 'ELIGIBLE' }
  /** The item's own status isn't PENDING/FAILED_RETRYABLE (e.g. IN_FLIGHT, SYNCED, already FAILED_TERMINAL). */
  | { readonly kind: 'NOT_PENDING'; readonly status: OutboxStatus }
  /** FAILED_RETRYABLE, but RetryPolicy.shouldRetry(item.attempts) says no attempts remain. Permanent — will not resolve on its own. */
  | { readonly kind: 'RETRY_LIMIT_EXCEEDED'; readonly attempts: number }
  /** FAILED_RETRYABLE, but its nextAttemptAt is still in the future. */
  | { readonly kind: 'BLOCKED_ON_RETRY_WINDOW'; readonly nextAttemptAt: string }
  /** Waiting on a prerequisite that may still succeed (PENDING, IN_FLIGHT, or FAILED_RETRYABLE). */
  | { readonly kind: 'BLOCKED_ON_DEPENDENCY'; readonly dependsOnOutboxId: string; readonly dependencyStatus: OutboxStatus }
  /** Waiting on a prerequisite that failed terminally — will not resolve on its own without intervention. */
  | { readonly kind: 'BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY'; readonly dependsOnOutboxId: string }
  /** dependsOnOutboxId doesn't match any item in the given set. Shouldn't happen given the schema's FK constraint; handled defensively rather than assumed away. */
  | { readonly kind: 'BLOCKED_ON_MISSING_DEPENDENCY'; readonly dependsOnOutboxId: string };

/**
 * Classifies a single item's dispatch eligibility against a snapshot of
 * outbox state, at a given moment in time. Pure: no I/O, no mutation, no
 * internal clock access (`now` is supplied by the caller, and
 * `retryPolicyConfig` defaults to the same DEFAULT_RETRY_POLICY_CONFIG
 * OutboxDispatcher already uses for backoff, so the two stay consistent
 * without every caller having to thread a config through) — the same
 * inputs always produce the same output.
 */
export function classifyOutboxEligibility(
  item: OutboxItem,
  itemsById: ReadonlyMap<string, OutboxItem>,
  now: string,
  retryPolicyConfig: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
): OutboxEligibility {
  if (!isSyncable(item.status)) {
    return { kind: 'NOT_PENDING', status: item.status };
  }

  if (item.status === 'FAILED_RETRYABLE' && !shouldRetry(item.attempts, retryPolicyConfig)) {
    return { kind: 'RETRY_LIMIT_EXCEEDED', attempts: item.attempts };
  }

  if (item.status === 'FAILED_RETRYABLE' && item.nextAttemptAt !== null && item.nextAttemptAt > now) {
    return { kind: 'BLOCKED_ON_RETRY_WINDOW', nextAttemptAt: item.nextAttemptAt };
  }

  if (item.dependsOnOutboxId === null) {
    return { kind: 'ELIGIBLE' };
  }

  const dependency = itemsById.get(item.dependsOnOutboxId);
  if (!dependency) {
    return { kind: 'BLOCKED_ON_MISSING_DEPENDENCY', dependsOnOutboxId: item.dependsOnOutboxId };
  }

  if (dependency.status === 'SYNCED') {
    return { kind: 'ELIGIBLE' };
  }

  if (dependency.status === 'FAILED_TERMINAL') {
    return { kind: 'BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY', dependsOnOutboxId: item.dependsOnOutboxId };
  }

  return {
    kind: 'BLOCKED_ON_DEPENDENCY',
    dependsOnOutboxId: item.dependsOnOutboxId,
    dependencyStatus: dependency.status,
  };
}

/** Classifies every item in a snapshot, keyed by id — useful for debug/inspection callers that need the "why", not just the eligible subset. */
export function evaluateOutboxEligibility(
  items: readonly OutboxItem[],
  now: string,
  retryPolicyConfig: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
): ReadonlyMap<string, OutboxEligibility> {
  const itemsById = new Map(items.map((item) => [item.id, item] as const));
  const result = new Map<string, OutboxEligibility>();

  for (const item of items) {
    result.set(item.id, classifyOutboxEligibility(item, itemsById, now, retryPolicyConfig));
  }

  return result;
}

/**
 * Deterministic dispatch order: oldest queued item first (createdAt
 * ascending), id as a stable tie-breaker when timestamps are equal. Never
 * relies on the order items were passed in or any database row order —
 * the same set of items, in any input order, always sorts identically.
 */
function compareForDispatchOrder(a: OutboxItem, b: OutboxItem): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * The items in `items` that are eligible for dispatch right now (at time
 * `now`), in deterministic dispatch order. Operates entirely on the given
 * in-memory snapshot — no SQLite queries, no network, no timers. A caller
 * (SyncEngine) calls this with a snapshot it already loaded (e.g. via
 * OutboxRepository.listAll()) and dispatches in the returned order. An
 * item classified RETRY_LIMIT_EXCEEDED is never ELIGIBLE, so it's
 * excluded here the same way any other non-eligible kind is — this
 * function still never writes anything.
 */
export function selectEligibleOutboxItems(
  items: readonly OutboxItem[],
  now: string,
  retryPolicyConfig: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
): readonly OutboxItem[] {
  const itemsById = new Map(items.map((item) => [item.id, item] as const));

  return items
    .filter((item) => classifyOutboxEligibility(item, itemsById, now, retryPolicyConfig).kind === 'ELIGIBLE')
    .sort(compareForDispatchOrder);
}
