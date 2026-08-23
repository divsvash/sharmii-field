import type { OutboxItem, OutboxStatus } from '../../../src/domain/sync/OutboxItem';
import { asIdempotencyKey } from '../../../src/domain/sync/OutboxItem';
import {
  classifyOutboxEligibility,
  evaluateOutboxEligibility,
  selectEligibleOutboxItems,
} from '../../../src/domain/sync/OutboxDispatchSelector';

const NOW = '2026-08-21T12:00:00.000Z';

function makeItem(overrides: Partial<OutboxItem> & Pick<OutboxItem, 'id'>): OutboxItem {
  return {
    operation: 'PUNCH_IN',
    entityId: `entity-${overrides.id}`,
    idempotencyKey: asIdempotencyKey(`idem-${overrides.id}`),
    dependsOnOutboxId: null,
    payload: {},
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: '2026-08-21T09:00:00.000Z',
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * The exact scenario from the spec:
 *   A  PUNCH_IN   PENDING
 *   B  PUNCH_OUT  PENDING   depends_on=A
 *   C  INCIDENT   PENDING
 *   D  PHOTO      PENDING   depends_on=C
 */
function scenario(overrides: {
  a?: Partial<OutboxItem>;
  b?: Partial<OutboxItem>;
  c?: Partial<OutboxItem>;
  d?: Partial<OutboxItem>;
} = {}): { a: OutboxItem; b: OutboxItem; c: OutboxItem; d: OutboxItem; all: OutboxItem[] } {
  const a = makeItem({
    id: 'A',
    operation: 'PUNCH_IN',
    createdAt: '2026-08-21T09:00:00.000Z',
    ...overrides.a,
  });
  const b = makeItem({
    id: 'B',
    operation: 'PUNCH_OUT',
    dependsOnOutboxId: 'A',
    createdAt: '2026-08-21T09:01:00.000Z',
    ...overrides.b,
  });
  const c = makeItem({
    id: 'C',
    operation: 'INCIDENT_CREATE',
    createdAt: '2026-08-21T09:02:00.000Z',
    ...overrides.c,
  });
  const d = makeItem({
    id: 'D',
    operation: 'INCIDENT_PHOTO_UPLOAD',
    dependsOnOutboxId: 'C',
    createdAt: '2026-08-21T09:03:00.000Z',
    ...overrides.d,
  });

  return { a, b, c, d, all: [a, b, c, d] };
}

describe('selectEligibleOutboxItems — the spec scenario', () => {
  it('selects A and C as eligible; B and D remain blocked on their PENDING dependencies', () => {
    const { all } = scenario();

    const eligible = selectEligibleOutboxItems(all, NOW);

    expect(eligible.map((i) => i.id)).toEqual(['A', 'C']);
  });

  it('makes B eligible once A becomes SYNCED', () => {
    const { all } = scenario({ a: { status: 'SYNCED' } });

    const eligible = selectEligibleOutboxItems(all, NOW);

    expect(eligible.map((i) => i.id)).toEqual(['B', 'C']);
  });

  it('keeps B blocked while A is FAILED_RETRYABLE', () => {
    const { all } = scenario({ a: { status: 'FAILED_RETRYABLE', attempts: 1 } });

    const eligible = selectEligibleOutboxItems(all, NOW);

    // A itself is still syncable (FAILED_RETRYABLE), so it's eligible again; B stays blocked.
    expect(eligible.map((i) => i.id)).toEqual(['A', 'C']);
  });

  it('never dispatches B while A is FAILED_TERMINAL', () => {
    const { all } = scenario({ a: { status: 'FAILED_TERMINAL', attempts: 3 } });

    const eligible = selectEligibleOutboxItems(all, NOW);

    expect(eligible.map((i) => i.id)).not.toContain('B');
    expect(eligible.map((i) => i.id)).toEqual(['C']);
  });
});

describe('classifyOutboxEligibility — distinguishing blocked reasons', () => {
  it('classifies an item with no dependency as ELIGIBLE', () => {
    const { a, all } = scenario();
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(a, byId, NOW)).toEqual({ kind: 'ELIGIBLE' });
  });

  it('classifies a dependent on a PENDING prerequisite as BLOCKED_ON_DEPENDENCY', () => {
    const { b, all } = scenario();
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(b, byId, NOW)).toEqual({
      kind: 'BLOCKED_ON_DEPENDENCY',
      dependsOnOutboxId: 'A',
      dependencyStatus: 'PENDING',
    });
  });

  it('classifies a dependent on an IN_FLIGHT prerequisite as BLOCKED_ON_DEPENDENCY', () => {
    const { b, all } = scenario({ a: { status: 'IN_FLIGHT' } });
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(b, byId, NOW)).toEqual({
      kind: 'BLOCKED_ON_DEPENDENCY',
      dependsOnOutboxId: 'A',
      dependencyStatus: 'IN_FLIGHT',
    });
  });

  it('classifies a dependent on a FAILED_RETRYABLE prerequisite as BLOCKED_ON_DEPENDENCY (still distinguishable from terminal)', () => {
    const { b, all } = scenario({ a: { status: 'FAILED_RETRYABLE', attempts: 2 } });
    const byId = new Map(all.map((i) => [i.id, i]));

    const result = classifyOutboxEligibility(b, byId, NOW);

    expect(result.kind).toBe('BLOCKED_ON_DEPENDENCY');
    expect(result).not.toMatchObject({ kind: 'BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY' });
  });

  it('classifies a dependent on a FAILED_TERMINAL prerequisite as BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY (distinguishable from a normal retryable block)', () => {
    const { b, all } = scenario({ a: { status: 'FAILED_TERMINAL', attempts: 3 } });
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(b, byId, NOW)).toEqual({
      kind: 'BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY',
      dependsOnOutboxId: 'A',
    });
  });

  it('classifies a dependent on a SYNCED prerequisite as ELIGIBLE', () => {
    const { b, all } = scenario({ a: { status: 'SYNCED' } });
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(b, byId, NOW)).toEqual({ kind: 'ELIGIBLE' });
  });

  it('classifies an item whose own status is IN_FLIGHT as NOT_PENDING (no double-dispatch)', () => {
    const { a, all } = scenario({ a: { status: 'IN_FLIGHT' } });
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(a, byId, NOW)).toEqual({ kind: 'NOT_PENDING', status: 'IN_FLIGHT' });
  });

  it('classifies an item whose own status is SYNCED as NOT_PENDING', () => {
    const { a, all } = scenario({ a: { status: 'SYNCED' } });
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(a, byId, NOW)).toEqual({ kind: 'NOT_PENDING', status: 'SYNCED' });
  });

  it('classifies an item whose own status is FAILED_TERMINAL as NOT_PENDING', () => {
    const { a, all } = scenario({ a: { status: 'FAILED_TERMINAL', attempts: 5 } });
    const byId = new Map(all.map((i) => [i.id, i]));

    expect(classifyOutboxEligibility(a, byId, NOW)).toEqual({ kind: 'NOT_PENDING', status: 'FAILED_TERMINAL' });
  });

  it('classifies a dependent whose dependency is absent from the snapshot as BLOCKED_ON_MISSING_DEPENDENCY, defensively', () => {
    const orphan = makeItem({ id: 'B', dependsOnOutboxId: 'does-not-exist' });
    const byId = new Map<string, OutboxItem>([['B', orphan]]);

    expect(classifyOutboxEligibility(orphan, byId, NOW)).toEqual({
      kind: 'BLOCKED_ON_MISSING_DEPENDENCY',
      dependsOnOutboxId: 'does-not-exist',
    });
  });
});

describe('classifyOutboxEligibility — never mutates or marks anything terminal', () => {
  it('does not alter the dependent item when its dependency is terminally failed', () => {
    const { b, all } = scenario({ a: { status: 'FAILED_TERMINAL', attempts: 3 } });
    const byId = new Map(all.map((i) => [i.id, i]));
    const before = { ...b };

    classifyOutboxEligibility(b, byId, NOW);

    expect(b).toEqual(before);
    expect(b.status).toBe('PENDING'); // never cascaded to FAILED_TERMINAL by this module
  });
});

describe('evaluateOutboxEligibility', () => {
  it('classifies every item in the set, keyed by id', () => {
    const { all } = scenario({ a: { status: 'FAILED_TERMINAL', attempts: 3 } });

    const evaluation = evaluateOutboxEligibility(all, NOW);

    expect(evaluation.get('A')).toEqual({ kind: 'NOT_PENDING', status: 'FAILED_TERMINAL' });
    expect(evaluation.get('B')).toEqual({
      kind: 'BLOCKED_ON_TERMINALLY_FAILED_DEPENDENCY',
      dependsOnOutboxId: 'A',
    });
    expect(evaluation.get('C')).toEqual({ kind: 'ELIGIBLE' });
    expect(evaluation.get('D')).toEqual({
      kind: 'BLOCKED_ON_DEPENDENCY',
      dependsOnOutboxId: 'C',
      dependencyStatus: 'PENDING',
    });
  });
});

describe('selectEligibleOutboxItems — deterministic ordering', () => {
  it('orders eligible items oldest-created first', () => {
    const older = makeItem({ id: 'X', createdAt: '2026-08-21T08:00:00.000Z' });
    const newer = makeItem({ id: 'Y', createdAt: '2026-08-21T09:00:00.000Z' });

    // Pass them in reverse-chronological input order to prove the output
    // order comes from sorting, not from input order.
    const eligible = selectEligibleOutboxItems([newer, older], NOW);

    expect(eligible.map((i) => i.id)).toEqual(['X', 'Y']);
  });

  it('breaks ties on identical createdAt using id as a stable secondary key', () => {
    const sameTime = '2026-08-21T09:00:00.000Z';
    const itemZ = makeItem({ id: 'Z', createdAt: sameTime });
    const itemM = makeItem({ id: 'M', createdAt: sameTime });
    const itemA = makeItem({ id: 'A', createdAt: sameTime });

    const eligible = selectEligibleOutboxItems([itemZ, itemM, itemA], NOW);

    expect(eligible.map((i) => i.id)).toEqual(['A', 'M', 'Z']);
  });

  it('produces identical output regardless of input array order (does not rely on row order)', () => {
    const { all } = scenario({ a: { status: 'SYNCED' } });
    const shuffled = [all[3], all[1], all[2], all[0]] as OutboxItem[];

    const fromOriginalOrder = selectEligibleOutboxItems(all, NOW);
    const fromShuffledOrder = selectEligibleOutboxItems(shuffled, NOW);

    expect(fromShuffledOrder.map((i) => i.id)).toEqual(fromOriginalOrder.map((i) => i.id));
  });

  it('is a pure function: does not mutate the input array or its items', () => {
    const { all } = scenario();
    const snapshotBefore = all.map((i) => ({ ...i }));

    selectEligibleOutboxItems(all, NOW);

    expect(all).toEqual(snapshotBefore);
  });

  it('returns an empty array when nothing is eligible', () => {
    const allInFlight: OutboxItem[] = [
      makeItem({ id: 'A', status: 'IN_FLIGHT' }),
      makeItem({ id: 'B', status: 'SYNCED' }),
      makeItem({ id: 'C', status: 'FAILED_TERMINAL' }),
    ];

    expect(selectEligibleOutboxItems(allInFlight, NOW)).toEqual([]);
  });
});

describe('selectEligibleOutboxItems — status coverage', () => {
  it.each<OutboxStatus>(['PENDING', 'FAILED_RETRYABLE'])(
    'includes an independent (no dependency) item with status %s',
    (status) => {
      const item = makeItem({ id: 'X', status, dependsOnOutboxId: null });

      expect(selectEligibleOutboxItems([item], NOW).map((i) => i.id)).toEqual(['X']);
    },
  );

  it.each<OutboxStatus>(['IN_FLIGHT', 'SYNCED', 'FAILED_TERMINAL'])(
    'excludes an independent item with status %s',
    (status) => {
      const item = makeItem({ id: 'X', status, dependsOnOutboxId: null });

      expect(selectEligibleOutboxItems([item], NOW)).toEqual([]);
    },
  );
});

describe('selectEligibleOutboxItems / classifyOutboxEligibility — retry-window gating', () => {
  it('excludes a FAILED_RETRYABLE item whose nextAttemptAt is still in the future', () => {
    const item = makeItem({
      id: 'X',
      status: 'FAILED_RETRYABLE',
      nextAttemptAt: '2026-08-21T13:00:00.000Z', // after NOW
    });

    expect(selectEligibleOutboxItems([item], NOW)).toEqual([]);

    const byId = new Map([['X', item]]);
    expect(classifyOutboxEligibility(item, byId, NOW)).toEqual({
      kind: 'BLOCKED_ON_RETRY_WINDOW',
      nextAttemptAt: '2026-08-21T13:00:00.000Z',
    });
  });

  it('includes a FAILED_RETRYABLE item once nextAttemptAt has elapsed', () => {
    const item = makeItem({
      id: 'X',
      status: 'FAILED_RETRYABLE',
      nextAttemptAt: '2026-08-21T11:00:00.000Z', // before NOW
    });

    expect(selectEligibleOutboxItems([item], NOW).map((i) => i.id)).toEqual(['X']);
  });

  it('includes a FAILED_RETRYABLE item exactly at its nextAttemptAt boundary', () => {
    const item = makeItem({ id: 'X', status: 'FAILED_RETRYABLE', nextAttemptAt: NOW });

    // nextAttemptAt > now is the exclusion condition, so nextAttemptAt === now is eligible.
    expect(selectEligibleOutboxItems([item], NOW).map((i) => i.id)).toEqual(['X']);
  });

  it('includes a FAILED_RETRYABLE item with no nextAttemptAt at all (never gated)', () => {
    const item = makeItem({ id: 'X', status: 'FAILED_RETRYABLE', nextAttemptAt: null });

    expect(selectEligibleOutboxItems([item], NOW).map((i) => i.id)).toEqual(['X']);
  });

  it('ignores nextAttemptAt for a PENDING item (the field is only meaningful for FAILED_RETRYABLE)', () => {
    // A PENDING item should never have a set nextAttemptAt in practice, but
    // the selector must not accidentally gate on it if it did.
    const item = makeItem({ id: 'X', status: 'PENDING', nextAttemptAt: '2099-01-01T00:00:00.000Z' });

    expect(selectEligibleOutboxItems([item], NOW).map((i) => i.id)).toEqual(['X']);
  });

  it('blocks a dependent whose prerequisite is FAILED_RETRYABLE but still inside its retry window', () => {
    const a = makeItem({
      id: 'A',
      status: 'FAILED_RETRYABLE',
      nextAttemptAt: '2026-08-21T13:00:00.000Z',
      createdAt: '2026-08-21T09:00:00.000Z',
    });
    const b = makeItem({ id: 'B', dependsOnOutboxId: 'A', createdAt: '2026-08-21T09:01:00.000Z' });

    expect(selectEligibleOutboxItems([a, b], NOW)).toEqual([]);
  });
});
