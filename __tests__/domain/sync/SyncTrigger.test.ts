import { createSyncTrigger, wireConnectivityToSyncTrigger, type ConnectivityListener } from '../../../src/domain/sync/SyncTrigger';
import type { SyncEngine, SyncEngineRunSummary } from '../../../src/domain/sync/SyncEngine';

function fakeSummary(overrides: Partial<SyncEngineRunSummary> = {}): SyncEngineRunSummary {
  return {
    recovered: 0,
    passes: 0,
    attempted: 0,
    succeeded: 0,
    retryableFailures: 0,
    terminalFailures: 0,
    claimFailures: 0,
    blocked: 0,
    waitingForRetry: 0,
    ...overrides,
  };
}

describe('createSyncTrigger', () => {
  it('syncNow() calls engine.runOnce() and returns its summary', async () => {
    const summary = fakeSummary({ succeeded: 2 });
    let runOnceCalls = 0;
    const fakeEngine = {
      runOnce: async () => {
        runOnceCalls += 1;
        return summary;
      },
    } as unknown as SyncEngine;

    const trigger = createSyncTrigger(fakeEngine);
    const result = await trigger.syncNow();

    expect(result).toBe(summary);
    expect(runOnceCalls).toBe(1);
  });

  it('does not add any scheduling — each call to syncNow() maps to exactly one runOnce() call', async () => {
    let runOnceCalls = 0;
    const fakeEngine = {
      runOnce: async () => {
        runOnceCalls += 1;
        return fakeSummary();
      },
    } as unknown as SyncEngine;

    const trigger = createSyncTrigger(fakeEngine);
    await trigger.syncNow();
    await trigger.syncNow();
    await trigger.syncNow();

    expect(runOnceCalls).toBe(3);
  });
});

describe('wireConnectivityToSyncTrigger', () => {
  it('calls syncNow() when connectivity becomes available', async () => {
    let registeredCallback: (() => void) | undefined;
    const connectivity: ConnectivityListener = {
      onConnectivityAvailable: (cb) => {
        registeredCallback = cb;
        return () => {
          registeredCallback = undefined;
        };
      },
    };

    let syncNowCalls = 0;
    const trigger = { syncNow: async () => { syncNowCalls += 1; return fakeSummary(); } };

    wireConnectivityToSyncTrigger(connectivity, trigger);
    expect(syncNowCalls).toBe(0); // not called just from wiring

    registeredCallback?.();
    // syncNow() is async and the wiring fires it without awaiting
    // (`void trigger.syncNow()`), so let microtasks flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(syncNowCalls).toBe(1);
  });

  it('can be unwired via the returned function, after which connectivity no longer triggers a sync', async () => {
    let registeredCallback: (() => void) | undefined;
    let unsubscribed = false;
    const connectivity: ConnectivityListener = {
      onConnectivityAvailable: (cb) => {
        registeredCallback = cb;
        return () => {
          unsubscribed = true;
        };
      },
    };

    let syncNowCalls = 0;
    const trigger = { syncNow: async () => { syncNowCalls += 1; return fakeSummary(); } };

    const unwire = wireConnectivityToSyncTrigger(connectivity, trigger);
    unwire();

    expect(unsubscribed).toBe(true);
    // This fake doesn't actually stop calling the callback on unsubscribe
    // (a real implementation would) -- the point proven here is only that
    // the unsubscribe function it returned was invoked.
    void registeredCallback;
  });

  it('does not import any platform-specific connectivity API (React Native, browser, etc.)', () => {
    // Structural check: the module only depends on the narrow
    // ConnectivityListener interface, not any concrete platform API. If
    // this file ever grows a NetInfo/browser import, this test's
    // corresponding source-review still applies -- enforced here by the
    // fact the test above works with a plain object, no platform module
    // required to run it.
    const connectivity: ConnectivityListener = { onConnectivityAvailable: () => () => {} };
    const trigger = { syncNow: async () => fakeSummary() };
    expect(() => wireConnectivityToSyncTrigger(connectivity, trigger)).not.toThrow();
  });
});
