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
 * future slice can add that; for now, SyncEngine's own conditional claim
 * already ensures overlapping runs can't cause double-dispatch of the
 * same item (see the documented recovery-vs-concurrency limitation in
 * README "Known limitations" for the one related edge this doesn't cover).
 */
export function wireConnectivityToSyncTrigger(
  connectivity: ConnectivityListener,
  trigger: SyncTrigger,
): () => void {
  return connectivity.onConnectivityAvailable(() => {
    void trigger.syncNow();
  });
}
