import { isValidFilesystemPath } from '../../shared/filesystemPath';
import type { IdempotencyKey } from '../sync/OutboxItem';

export type PunchType = 'IN' | 'OUT';

/**
 * A single clock-in/clock-out event, recorded locally regardless of
 * connectivity. `relatedPunchInId` is set only on OUT punches and is the
 * domain-level encoding of invariant 3 (punch-out cannot sync before its
 * punch-in) — independent of however the outbox chooses to encode the same
 * dependency for sync ordering.
 *
 * Deliberately has NO sync-status field. The corresponding outbox item
 * (domain/sync/OutboxItem.ts, looked up by entityId) is the single source
 * of truth for this punch's synchronization state. Adding a second,
 * independently-mutable status here would create two representations of
 * the same fact that a process death could leave disagreeing with each
 * other — exactly the failure mode invariant 1 exists to prevent. A future
 * Punch History UI derives sync state by joining/looking up the outbox
 * item for a punch, not by reading a field on Punch itself.
 */
export interface Punch {
  readonly id: string;
  readonly employeeId: string;
  readonly siteId: string;
  readonly type: PunchType;
  readonly clientTimestamp: string; // ISO8601, device clock at time of punch
  readonly latitude: number;
  readonly longitude: number;
  readonly gpsAccuracyMeters: number;
  /** True when the OS/GPS provider flagged this location as mocked/spoofed. */
  readonly isMockLocation: boolean;
  /** Filesystem URI (expo-file-system) of the verification selfie — never base64. */
  readonly selfiePath: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly relatedPunchInId: string | null;
  readonly createdAt: string; // ISO8601, local persistence time
}

export type NewPunchIn = Omit<Punch, 'type' | 'relatedPunchInId'> & {
  readonly type: 'IN';
  readonly relatedPunchInId: null;
};

export type NewPunchOut = Omit<Punch, 'type'> & {
  readonly type: 'OUT';
  readonly relatedPunchInId: string; // required, not nullable, for OUT
};

export class PunchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PunchValidationError';
  }
}

interface GeoParams {
  readonly latitude: number;
  readonly longitude: number;
  readonly gpsAccuracyMeters: number;
}

function assertValidGeo(geo: GeoParams): void {
  if (geo.latitude < -90 || geo.latitude > 90) {
    throw new PunchValidationError(`Invalid latitude: ${geo.latitude}`);
  }
  if (geo.longitude < -180 || geo.longitude > 180) {
    throw new PunchValidationError(`Invalid longitude: ${geo.longitude}`);
  }
  if (geo.gpsAccuracyMeters < 0 || !Number.isFinite(geo.gpsAccuracyMeters)) {
    throw new PunchValidationError(`Invalid gpsAccuracyMeters: ${geo.gpsAccuracyMeters}`);
  }
}

function assertValidSelfiePath(selfiePath: string): void {
  if (!isValidFilesystemPath(selfiePath)) {
    throw new PunchValidationError(
      'Punch.selfiePath must be a non-empty filesystem URI, not a base64 data URI',
    );
  }
}

interface NewPunchInParams {
  readonly id: string;
  readonly employeeId: string;
  readonly siteId: string;
  readonly clientTimestamp: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly gpsAccuracyMeters: number;
  readonly isMockLocation: boolean;
  readonly selfiePath: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly createdAt: string;
}

export function createPunchIn(params: NewPunchInParams): NewPunchIn {
  assertValidGeo(params);
  assertValidSelfiePath(params.selfiePath);

  return {
    id: params.id,
    employeeId: params.employeeId,
    siteId: params.siteId,
    type: 'IN',
    clientTimestamp: params.clientTimestamp,
    latitude: params.latitude,
    longitude: params.longitude,
    gpsAccuracyMeters: params.gpsAccuracyMeters,
    isMockLocation: params.isMockLocation,
    selfiePath: params.selfiePath,
    idempotencyKey: params.idempotencyKey,
    relatedPunchInId: null,
    createdAt: params.createdAt,
  };
}

interface NewPunchOutParams {
  readonly id: string;
  readonly employeeId: string;
  readonly siteId: string;
  readonly clientTimestamp: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly gpsAccuracyMeters: number;
  readonly isMockLocation: boolean;
  readonly selfiePath: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly punchIn: Punch;
  readonly createdAt: string;
}

/**
 * Domain rule backing invariant 3. A punch-out must reference an existing
 * local punch-in row before it is even constructed — this is checked here,
 * independent of and prior to any outbox/sync concern.
 */
export function createPunchOut(params: NewPunchOutParams): NewPunchOut {
  const { punchIn } = params;

  if (punchIn.type !== 'IN') {
    throw new PunchValidationError(
      `Cannot create punch-out against punch ${punchIn.id}: referenced punch is not type IN`,
    );
  }
  if (punchIn.employeeId !== params.employeeId) {
    throw new PunchValidationError(
      `Cannot create punch-out: punch-in ${punchIn.id} belongs to a different employee`,
    );
  }
  if (params.clientTimestamp < punchIn.clientTimestamp) {
    throw new PunchValidationError(
      'Cannot create punch-out with a timestamp earlier than its punch-in',
    );
  }
  assertValidGeo(params);
  assertValidSelfiePath(params.selfiePath);

  return {
    id: params.id,
    employeeId: params.employeeId,
    siteId: params.siteId,
    type: 'OUT',
    clientTimestamp: params.clientTimestamp,
    latitude: params.latitude,
    longitude: params.longitude,
    gpsAccuracyMeters: params.gpsAccuracyMeters,
    isMockLocation: params.isMockLocation,
    selfiePath: params.selfiePath,
    idempotencyKey: params.idempotencyKey,
    relatedPunchInId: punchIn.id,
    createdAt: params.createdAt,
  };
}
