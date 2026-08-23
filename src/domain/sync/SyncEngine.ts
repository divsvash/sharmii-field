import type { OutboxItem } from './OutboxItem';
import type { OutboxDispatchStore } from './OutboxDispatchStore';
import { dispatchOutboxItem } from './OutboxDispatcher';
import {
  evaluateOutboxEligibility,
  selectEligibleOutboxItems,
  type OutboxEligibility,
} from './OutboxDispatchSelector';
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
  recoverInFlightItems(): Promise<number>;
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
}

function isDependencyBlockedKind(kind: OutboxEligibility['kind']): boolean {
  return (
    kind === 'BLOCKED_ON_DEPENDENCY' ||
    kind === 'BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY' ||
    kind === 'BLOCKED_ON_MISSING_DEPENDENCY'
  );
}

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
 * re-dispatched within this run — whether/when it gets another attempt is
 * RetryPolicy's decision, not this engine's, and RetryPolicy is not wired
 * up in this slice (see the boundary note below). A pass therefore either
 * dispatches at least one item never attempted before in this run
 * (progress), or selects nothing new and the loop stops — bounded by the
 * total number of items, so termination is guaranteed.
 *
 * Retry-timing boundary: as of this slice, retry timing (nextAttemptAt)
 * IS persisted (by OutboxDispatcher, via RetryPolicy.nextDelayMs) and IS
 * enforced by the selector (selectEligibleOutboxItems rejects a
 * FAILED_RETRYABLE item whose nextAttemptAt hasn't elapsed). What remains
 * out of scope for this engine: it does not sleep or wait for a backoff
 * window to elapse — a caller must invoke runOnce() again (e.g. from a
 * connectivity listener or a manual trigger) for a previously-blocked
 * retry to have a chance of becoming eligible. This engine has no timer
 * of its own.
 */
export class SyncEngine {
  constructor(
    private readonly outboxSource: OutboxSnapshotSource,
    private readonly dispatchStore: OutboxDispatchStore,
    private readonly transport: SyncTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async runOnce(): Promise<SyncEngineRunSummary> {
    const recovered = await this.outboxSource.recoverInFlightItems();

    const attemptedIds = new Set<string>();
    let attempted = 0;
    let succeeded = 0;
    let retryableFailures = 0;
    let terminalFailures = 0;
    let claimFailures = 0;
    let passes = 0;
    let latestSnapshot: readonly OutboxItem[] = await this.outboxSource.listAll();

    for (;;) {
      const eligible = selectEligibleOutboxItems(latestSnapshot, this.now());
      const toDispatch = eligible.filter((item) => !attemptedIds.has(item.id));

      if (toDispatch.length === 0) {
        break;
      }

      passes += 1;

      // Sequential by design — the deterministic order the selector
      // already established is preserved exactly, one at a time.
      for (const item of toDispatch) {
        const outcome = await dispatchOutboxItem(item, this.transport, this.dispatchStore, this.now);
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
    }

    const finalEligibility = evaluateOutboxEligibility(latestSnapshot, this.now());
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
    };
  }
}
