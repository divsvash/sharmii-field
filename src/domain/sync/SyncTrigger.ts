import type { SyncEngine, SyncEngineRunSummary } from './SyncEngine';

/**
 * The entire "trigger a sync" surface. `syncNow()` is exactly
 * `SyncEngine.runOnce()`, exposed under a name a UI button or a
 * connectivity callback can call without knowing SyncEngine exists.
 * Nothing here adds scheduling, timers, or a background loop — this is a
 * boundary, not an implementation of automatic syncing.
 */
export interface SyncTrigger {
  syncNow(): Promise<SyncEngineRunSummary>;
}

/** The obvious implementation: syncNow() is runOnce(). No extra state, no queueing of concurrent calls (see the doc on createSyncTrigger below). */
export function createSyncTrigger(engine: SyncEngine): SyncTrigger {
  return {
    syncNow: () => engine.runOnce(),
  };
}

/**
 * Narrow interface a platform-specific connectivity integration (e.g.
 * NetInfo on React Native, or a browser 'online' event) can implement.
 * Deliberately just "here's a way to be told connectivity came back" —
 * no reconnection backoff, no polling, no platform import anywhere in
 * this file. A real implementation lives in a future features/ or
 * platform-specific module; it is NOT built in this sprint.
 */
export interface ConnectivityListener {
  /** Registers `onAvailable` to be called whenever connectivity transitions from unavailable to available. Returns a function that unregisters it. */
  onConnectivityAvailable(onAvailable: () => void): () => void;
}

/**
 * Wires a ConnectivityListener to a SyncTrigger: whenever connectivity
 * becomes available, call syncNow(). This is the "connectivity becomes
 * available -> syncNow()" arrow from the architecture diagram, and
 * nothing more — no debounce, no retry-of-the-trigger-itself, no queueing
 * beyond what's described below. Returns the same unsubscribe function
 * ConnectivityListener.onConnectivityAvailable returned, so the caller can
 * tear this down.
 *
 * Concurrency note: if connectivity flaps rapidly, multiple syncNow()
 * calls could overlap. This function does not guard against that — doing
 * so would mean adding a queue/lock, which is exactly the kind of
 * scheduler-service complexity this sprint's constraints rule out. A
 * future slice can add that; for now, two overlapping calls are still
 * safe against double-dispatching the *same* item: tryClaim's conditional
 * UPDATE means only one caller can ever hold a given item's IN_FLIGHT
 * claim, and recoverInFlightItems() only reclaims a claim once it's old
 * enough that it can no longer plausibly belong to a still-live sibling
 * call (see SyncEngine.DEFAULT_RECOVERY_STALE_AFTER_MS) — so a second,
 * overlapping runOnce() call will not un-claim and re-dispatch an item the
 * first call is still genuinely working on. What overlapping calls can
 * still do, harmlessly, is duplicate *selection* work on items neither has
 * claimed yet (both read the same PENDING item, one wins tryClaim, the
 * other gets CLAIM_FAILED) — wasted CPU, not a duplicate HTTP request.
 */
export function wireConnectivityToSyncTrigger(
  connectivity: ConnectivityListener,
  trigger: SyncTrigger,
): () => void {
  return connectivity.onConnectivityAvailable(() => {
    void trigger.syncNow();
  });
}
