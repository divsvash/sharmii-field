import { isValidFilesystemPath } from '../../shared/filesystemPath';
import type { IdempotencyKey } from '../sync/OutboxItem';

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Incident {
  readonly id: string;
  readonly employeeId: string;
  readonly category: string;
  readonly description: string;
  readonly severity: IncidentSeverity;
  readonly clientTimestamp: string; // ISO8601
  readonly idempotencyKey: IdempotencyKey;
  readonly createdAt: string; // ISO8601
}

export type NewIncident = Incident;

/**
 * A photo attached to an incident. `filePath` is a filesystem URI
 * (expo-file-system), never a base64 blob — invariant 7. SQLite stores only
 * the path; the bytes live on disk and are managed by data/db + a future
 * file-storage adapter.
 */
export interface IncidentPhoto {
  readonly id: string;
  readonly incidentId: string;
  readonly filePath: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly createdAt: string; // ISO8601
}

/** An incident may carry at most this many photos. */
export const MAX_INCIDENT_PHOTOS = 3;

export class IncidentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentValidationError';
  }
}

/**
 * Domain rule backing invariant 4: an incident photo cannot be constructed
 * without a reference to an already-existing local incident. Also enforces
 * the max-3-photos-per-incident rule.
 *
 * `existingPhotoCount` is supplied by the caller (which already had to
 * query IncidentPhotoRepository.listByIncident to get here) rather than
 * queried inside this function — keeping this function pure and testable
 * without a repository or database.
 */
export function createIncidentPhoto(params: {
  readonly id: string;
  readonly incident: Incident;
  readonly filePath: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly createdAt: string;
  readonly existingPhotoCount: number;
}): IncidentPhoto {
  if (params.existingPhotoCount >= MAX_INCIDENT_PHOTOS) {
    throw new IncidentValidationError(
      `Incident ${params.incident.id} already has the maximum of ${MAX_INCIDENT_PHOTOS} photos`,
    );
  }
  if (!isValidFilesystemPath(params.filePath)) {
    throw new IncidentValidationError(
      'IncidentPhoto.filePath must be a non-empty filesystem URI, not a base64 data URI',
    );
  }

  return {
    id: params.id,
    incidentId: params.incident.id,
    filePath: params.filePath,
    idempotencyKey: params.idempotencyKey,
    createdAt: params.createdAt,
  };
}
