import type { OutboxItem } from './OutboxItem';
import type { OutboxDispatchStore } from './OutboxDispatchStore';
import { dispatchOutboxItem } from './OutboxDispatcher';
import {
  evaluateOutboxEligibility,
  selectEligibleOutboxItems,
  type OutboxEligibility,
} from './OutboxDispatchSelector';
import { DEFAULT_RETRY_POLICY_CONFIG, type RetryPolicyConfig } from './RetryPolicy';
import type { SyncError } from './SyncError';
import type { SyncTransport } from './SyncTransport';

/**
 * The narrow slice of OutboxRepository the engine needs to obtain a
 * working snapshot of outbox state: process-death recovery, and a full
 * read of current items. Deliberately excludes insert/getById/
 * getByEntityId/listSyncable — those aren't the engine's concern, and
 * depending on the full OutboxRepository here would let orchestration
 * code reach into write paths (insert) that belong to feature code, not
 * to sync orchestration. Any concrete OutboxRepository (Sqlite or
 * InMemory) already satisfies this structurally — no adapter needed.
 */
export interface OutboxSnapshotSource {
  recoverInFlightItems(staleAfterMs?: number): Promise<number>;
  listAll(): Promise<readonly OutboxItem[]>;
}

/**
 * Small, deterministic result of one runOnce() call — enough for tests
 * and basic observability, not a logging/metrics framework.
 */
export interface SyncEngineRunSummary {
  /** Items recovered from an abandoned IN_FLIGHT state before this run began. */
  readonly recovered: number;
  /** Number of selection passes performed (see runOnce() doc for why more than one may occur). */
  readonly passes: number;
  /** Total number of dispatchOutboxItem() calls made during this run. */
  readonly attempted: number;
  readonly succeeded: number;
  readonly retryableFailures: number;
  readonly terminalFailures: number;
  readonly claimFailures: number;
  /** Items left un-dispatched at the end of this run because a dependency hasn't resolved (or never will). */
  readonly blocked: number;
  /** Items left un-dispatched at the end of this run solely because their retry backoff window hasn't elapsed yet. */
  readonly waitingForRetry: number;
  /** Items transitioned FAILED_RETRYABLE -> FAILED_TERMINAL this run because RetryPolicy.shouldRetry ran out of attempts, without ever being dispatched again. */
  readonly retryLimitExceeded: number;
}

function isDependencyBlockedKind(kind: OutboxEligibility['kind']): boolean {
  return (
    kind === 'BLOCKED_ON_DEPENDENCY' ||
    kind === 'BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY' ||
    kind === 'BLOCKED_ON_MISSING_DEPENDENCY'
  );
}

/**
 * Default recovery staleness threshold passed to
 * OutboxSnapshotSource.recoverInFlightItems() at the start of every
 * runOnce() call — deliberately NOT 0 (unlike the unconditional recovery
 * openDatabase.ts performs once at process cold-start; see
 * OutboxRepository.recoverInFlightItems's doc for why those two cases
 * need different values).
 *
 * Sized relative to HttpSyncTransport's own default request timeout
 * (30s): a genuinely live, in-progress HTTP attempt will resolve — one
 * way or another — well within that window, at which point the
 * dispatcher itself moves the item out of IN_FLIGHT. An item still
 * IN_FLIGHT a full minute later cannot be a request that transport is
 * still legitimately waiting on; it can only be a claim nothing is ever
 * going to finish, i.e. genuinely abandoned. Generous on purpose — the
 * cost of waiting a little longer to recover a truly-dead item is low;
 * the cost of reclaiming a live one out from under a sibling call is a
 * real duplicate HTTP request (see the fullstack integration test this
 * value is proven against).
 */
export const DEFAULT_RECOVERY_STALE_AFTER_MS = 60_000;

/**
 * A single, framework-independent synchronization pass:
 *
 *   runOnce()
 *     - recoverInFlightItems()            (reuses OutboxRepository's existing recovery)
 *     - loop:
 *         - listAll()                     (fresh snapshot)
 *         - selectEligibleOutboxItems()    (reuses the frozen selector, unmodified)
 *         - dispatch every selected item not yet attempted THIS run,
 *           sequentially, via dispatchOutboxItem()  (reuses the frozen
 *           dispatcher unmodified — claiming, classification, and state
 *           transitions all stay exactly where they already live)
 *         - stop when a pass selects nothing new
 *     - return a deterministic summary
 *
 * No timers, no sleeping, no background loop, no concurrency (dispatch is
 * strictly sequential, in the selector's deterministic order), no HTTP.
 * Construct one of these with real collaborators, or fakes in tests, and
 * call runOnce() whenever the caller (a future connectivity listener or
 * manual trigger — neither built yet) decides a sync attempt should happen.
 *
 * Why more than one pass can occur in a single runOnce(): a dependent
 * item (e.g. a punch-out) isn't eligible until its prerequisite (the
 * punch-in) reaches SYNCED. If that happens during this same run, the
 * dependent should get a chance to dispatch immediately rather than
 * waiting for the next runOnce() call — so after dispatching everything
 * selected in one pass, the engine re-selects against fresh state.
 *
 * Why this can't loop forever: each item is dispatched at most once per
 * runOnce() call (tracked by id in `attemptedIds`). A retryable failure
 * makes the item selectable again immediately (FAILED_RETRYABLE is a
 * syncable status), but since it's already in `attemptedIds`, it is not
 * re-dispatched within this run — whether/when it gets another attempt
 * across *future* runs is bounded by RetryPolicy.shouldRetry, enforced via
 * finalizeExhaustedRetries() below, not by attemptedIds. A pass therefore
 * either dispatches at least one item never attempted before in this run
 * (progress), or selects nothing new and the loop stops — bounded by the
 * total number of items, so termination is guaranteed.
 *
 * Retry-timing boundary: retry timing (nextAttemptAt) IS persisted (by
 * OutboxDispatcher, via RetryPolicy.nextDelayMs) and IS enforced by the
 * selector (selectEligibleOutboxItems rejects a FAILED_RETRYABLE item
 * whose nextAttemptAt hasn't elapsed). What remains out of scope for this
 * engine: it does not sleep or wait for a backoff window to elapse — a
 * caller must invoke runOnce() again (e.g. from a connectivity listener or
 * a manual trigger) for a previously-blocked retry to have a chance of
 * becoming eligible. This engine has no timer of its own.
 *
 * Retry-limit boundary: RetryPolicy.shouldRetry/maxAttempts IS enforced —
 * finalizeExhaustedRetries() runs before selection (so an item that
 * exhausted its budget on a prior run never gets selected again) and
 * after every dispatch pass (so an item that exhausts its budget as a
 * result of a failure *this* run is finalized within the same runOnce()
 * call rather than lingering as FAILED_RETRYABLE until the next one).
 * Exhaustion is a local give-up, not a server rejection: it writes
 * FAILED_TERMINAL with reason RETRY_LIMIT_EXCEEDED directly via
 * dispatchStore.markFailed, without going through tryClaim/transport —
 * there is no HTTP request to make for a decision the client is making
 * about itself.
 *
 * Recovery-vs-concurrency boundary: recoverInFlightItems() is called with
 * `recoveryStaleAfterMs` (see DEFAULT_RECOVERY_STALE_AFTER_MS), not 0 —
 * an IN_FLIGHT item claimed too recently to plausibly be abandoned is
 * left alone, specifically so that a second, overlapping runOnce() call
 * (e.g. two connectivity events firing close together, or a manual
 * "sync now" during an existing run) can't reclaim and re-dispatch an
 * item a still-live sibling call already holds. This engine still does
 * not serialize concurrent runOnce() calls against each other — that
 * remains the caller's responsibility (see SyncTrigger) — but recovery no
 * longer treats "claimed recently" as "abandoned."
 */
export class SyncEngine {
  constructor(
    private readonly outboxSource: OutboxSnapshotSource,
    private readonly dispatchStore: OutboxDispatchStore,
    private readonly transport: SyncTransport,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly retryPolicyConfig: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
    private readonly recoveryStaleAfterMs: number = DEFAULT_RECOVERY_STALE_AFTER_MS,
  ) {}

  /**
   * Finalizes every item in `snapshot` currently classified
   * RETRY_LIMIT_EXCEEDED (FAILED_RETRYABLE with no attempts remaining):
   * writes FAILED_TERMINAL via dispatchStore.markFailed so it stops being
   * selectable, permanently. Returns how many items were finalized.
   *
   * Uses markFailed rather than a new store method — it's already exactly
   * the "write FAILED_TERMINAL with a SyncError, no nextAttemptAt"
   * operation this needs. One side effect worth naming: markFailed
   * increments `attempts` as part of its normal bookkeeping, so a
   * finalized item's stored `attempts` ends up one higher than the count
   * that actually triggered exhaustion. Harmless — the item is terminal
   * from here on, and RETRY_LIMIT_EXCEEDED's own message records the
   * attempt count that was actually evaluated.
   */
  private async finalizeExhaustedRetries(snapshot: readonly OutboxItem[]): Promise<number> {
    const eligibility = evaluateOutboxEligibility(snapshot, this.now(), this.retryPolicyConfig);
    let finalized = 0;

    for (const item of snapshot) {
      if (eligibility.get(item.id)?.kind !== 'RETRY_LIMIT_EXCEEDED') {
        continue;
      }

      const error: SyncError = {
        kind: 'terminal',
        reason: 'RETRY_LIMIT_EXCEEDED',
        message: `Exceeded retry limit after ${item.attempts} attempt(s)`,
        occurredAt: this.now(),
      };
      await this.dispatchStore.markFailed(item.id, error, 'FAILED_TERMINAL', null);
      finalized += 1;
    }

    return finalized;
  }

  async runOnce(): Promise<SyncEngineRunSummary> {
    const recovered = await this.outboxSource.recoverInFlightItems(this.recoveryStaleAfterMs);

    const attemptedIds = new Set<string>();
    let attempted = 0;
    let succeeded = 0;
    let retryableFailures = 0;
    let terminalFailures = 0;
    let claimFailures = 0;
    let passes = 0;
    let retryLimitExceeded = 0;

    let latestSnapshot: readonly OutboxItem[] = await this.outboxSource.listAll();
    retryLimitExceeded += await this.finalizeExhaustedRetries(latestSnapshot);
    if (retryLimitExceeded > 0) {
      latestSnapshot = await this.outboxSource.listAll();
    }

    for (;;) {
      const eligible = selectEligibleOutboxItems(latestSnapshot, this.now(), this.retryPolicyConfig);
      const toDispatch = eligible.filter((item) => !attemptedIds.has(item.id));

      if (toDispatch.length === 0) {
        break;
      }

      passes += 1;

      // Sequential by design — the deterministic order the selector
      // already established is preserved exactly, one at a time.
      for (const item of toDispatch) {
        const outcome = await dispatchOutboxItem(
          item,
          this.transport,
          this.dispatchStore,
          this.now,
          this.retryPolicyConfig,
        );
        attemptedIds.add(item.id);
        attempted += 1;

        switch (outcome.outcome) {
          case 'SYNCED':
            succeeded += 1;
            break;
          case 'FAILED_RETRYABLE':
            retryableFailures += 1;
            break;
          case 'FAILED_TERMINAL':
            terminalFailures += 1;
            break;
          case 'CLAIM_FAILED':
            claimFailures += 1;
            break;
          case 'NOT_ELIGIBLE':
            // Shouldn't happen: every item here came straight from
            // selectEligibleOutboxItems(), which already guarantees the
            // item's own status is syncable. Left uncounted rather than
            // added as a new summary field for a state that shouldn't be
            // reachable.
            break;
        }
      }

      latestSnapshot = await this.outboxSource.listAll();

      // A failure just recorded above may have pushed an item's attempts
      // to (or past) the retry limit this pass — finalize it now rather
      // than leaving it FAILED_RETRYABLE (and therefore still nominally
      // "syncable") until some future runOnce() call happens to notice.
      const newlyExhausted = await this.finalizeExhaustedRetries(latestSnapshot);
      retryLimitExceeded += newlyExhausted;
      if (newlyExhausted > 0) {
        latestSnapshot = await this.outboxSource.listAll();
      }
    }

    const finalEligibility = evaluateOutboxEligibility(latestSnapshot, this.now(), this.retryPolicyConfig);
    let blocked = 0;
    let waitingForRetry = 0;
    for (const eligibility of finalEligibility.values()) {
      if (isDependencyBlockedKind(eligibility.kind)) {
        blocked += 1;
      } else if (eligibility.kind === 'BLOCKED_ON_RETRY_WINDOW') {
        waitingForRetry += 1;
      }
    }

    return {
      recovered,
      passes,
      attempted,
      succeeded,
      retryableFailures,
      terminalFailures,
      claimFailures,
      blocked,
      waitingForRetry,
      retryLimitExceeded,
    };
  }
}
