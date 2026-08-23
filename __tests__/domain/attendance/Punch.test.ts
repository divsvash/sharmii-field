import { asIdempotencyKey } from '../../../src/domain/sync/OutboxItem';
import {
  createPunchIn,
  createPunchOut,
  PunchValidationError,
  type Punch,
} from '../../../src/domain/attendance/Punch';

function baseGeo() {
  return {
    latitude: 28.9845,
    longitude: 77.7064,
    gpsAccuracyMeters: 8.5,
    isMockLocation: false,
  };
}

function makePunchIn(overrides: Partial<Punch> = {}): Punch {
  return {
    id: 'punch-in-1',
    employeeId: 'emp-1',
    siteId: 'site-1',
    type: 'IN',
    clientTimestamp: '2026-08-18T09:00:00.000Z',
    ...baseGeo(),
    selfiePath: 'file:///data/selfies/punch-in-1.jpg',
    idempotencyKey: asIdempotencyKey('idem-in-1'),
    relatedPunchInId: null,
    createdAt: '2026-08-18T09:00:00.500Z',
    ...overrides,
  };
}

describe('createPunchIn', () => {
  it('creates a valid punch-in with geo and selfie captured', () => {
    const punchIn = createPunchIn({
      id: 'punch-in-1',
      employeeId: 'emp-1',
      siteId: 'site-1',
      clientTimestamp: '2026-08-18T09:00:00.000Z',
      ...baseGeo(),
      selfiePath: 'file:///data/selfies/punch-in-1.jpg',
      idempotencyKey: asIdempotencyKey('idem-in-1'),
      createdAt: '2026-08-18T09:00:00.500Z',
    });

    expect(punchIn.type).toBe('IN');
    expect(punchIn.relatedPunchInId).toBeNull();
    expect(punchIn.siteId).toBe('site-1');
  });

  it('rejects an out-of-range latitude', () => {
    expect(() =>
      createPunchIn({
        id: 'punch-in-2',
        employeeId: 'emp-1',
        siteId: 'site-1',
        clientTimestamp: '2026-08-18T09:00:00.000Z',
        ...baseGeo(),
        latitude: 200,
        selfiePath: 'file:///data/selfies/punch-in-2.jpg',
        idempotencyKey: asIdempotencyKey('idem-in-2'),
        createdAt: '2026-08-18T09:00:00.500Z',
      }),
    ).toThrow(PunchValidationError);
  });

  it('rejects a negative GPS accuracy', () => {
    expect(() =>
      createPunchIn({
        id: 'punch-in-3',
        employeeId: 'emp-1',
        siteId: 'site-1',
        clientTimestamp: '2026-08-18T09:00:00.000Z',
        ...baseGeo(),
        gpsAccuracyMeters: -1,
        selfiePath: 'file:///data/selfies/punch-in-3.jpg',
        idempotencyKey: asIdempotencyKey('idem-in-3'),
        createdAt: '2026-08-18T09:00:00.500Z',
      }),
    ).toThrow(PunchValidationError);
  });

  it('rejects a base64 data URI as selfiePath (invariant 7)', () => {
    expect(() =>
      createPunchIn({
        id: 'punch-in-4',
        employeeId: 'emp-1',
        siteId: 'site-1',
        clientTimestamp: '2026-08-18T09:00:00.000Z',
        ...baseGeo(),
        selfiePath: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        idempotencyKey: asIdempotencyKey('idem-in-4'),
        createdAt: '2026-08-18T09:00:00.500Z',
      }),
    ).toThrow(PunchValidationError);
  });
});

describe('createPunchOut', () => {
  it('creates a valid punch-out referencing its punch-in', () => {
    const punchIn = makePunchIn();

    const punchOut = createPunchOut({
      id: 'punch-out-1',
      employeeId: 'emp-1',
      siteId: 'site-1',
      clientTimestamp: '2026-08-18T17:00:00.000Z',
      ...baseGeo(),
      selfiePath: 'file:///data/selfies/punch-out-1.jpg',
      idempotencyKey: asIdempotencyKey('idem-out-1'),
      punchIn,
      createdAt: '2026-08-18T17:00:00.500Z',
    });

    expect(punchOut.type).toBe('OUT');
    expect(punchOut.relatedPunchInId).toBe(punchIn.id);
  });

  it('rejects a punch-out referencing a non-IN punch (invariant 3)', () => {
    const notAPunchIn = makePunchIn({ id: 'punch-out-existing', type: 'OUT' });

    expect(() =>
      createPunchOut({
        id: 'punch-out-2',
        employeeId: 'emp-1',
        siteId: 'site-1',
        clientTimestamp: '2026-08-18T17:00:00.000Z',
        ...baseGeo(),
        selfiePath: 'file:///data/selfies/punch-out-2.jpg',
        idempotencyKey: asIdempotencyKey('idem-out-2'),
        punchIn: notAPunchIn,
        createdAt: '2026-08-18T17:00:00.500Z',
      }),
    ).toThrow(PunchValidationError);
  });

  it('rejects a punch-out for a different employee than the punch-in', () => {
    const punchIn = makePunchIn({ employeeId: 'emp-1' });

    expect(() =>
      createPunchOut({
        id: 'punch-out-3',
        employeeId: 'emp-2',
        siteId: 'site-1',
        clientTimestamp: '2026-08-18T17:00:00.000Z',
        ...baseGeo(),
        selfiePath: 'file:///data/selfies/punch-out-3.jpg',
        idempotencyKey: asIdempotencyKey('idem-out-3'),
        punchIn,
        createdAt: '2026-08-18T17:00:00.500Z',
      }),
    ).toThrow(PunchValidationError);
  });

  it('rejects a punch-out timestamped before its punch-in', () => {
    const punchIn = makePunchIn({ clientTimestamp: '2026-08-18T09:00:00.000Z' });

    expect(() =>
      createPunchOut({
        id: 'punch-out-4',
        employeeId: 'emp-1',
        siteId: 'site-1',
        clientTimestamp: '2026-08-18T08:00:00.000Z',
        ...baseGeo(),
        selfiePath: 'file:///data/selfies/punch-out-4.jpg',
        idempotencyKey: asIdempotencyKey('idem-out-4'),
        punchIn,
        createdAt: '2026-08-18T09:00:00.500Z',
      }),
    ).toThrow(PunchValidationError);
  });

  it('rejects a punch-out missing a valid selfiePath', () => {
    const punchIn = makePunchIn();

    expect(() =>
      createPunchOut({
        id: 'punch-out-5',
        employeeId: 'emp-1',
        siteId: 'site-1',
        clientTimestamp: '2026-08-18T17:00:00.000Z',
        ...baseGeo(),
        selfiePath: '   ',
        idempotencyKey: asIdempotencyKey('idem-out-5'),
        punchIn,
        createdAt: '2026-08-18T17:00:00.500Z',
      }),
    ).toThrow(PunchValidationError);
  });
});
