import type { SqlDatabase } from './SqlDatabase';
import type { Punch, PunchType } from '../../domain/attendance/Punch';
import type { PunchRepository } from '../../domain/attendance/PunchRepository';
import { asIdempotencyKey } from '../../domain/sync/OutboxItem';

interface PunchRow {
  id: string;
  employee_id: string;
  site_id: string;
  type: string;
  client_timestamp: string;
  latitude: number;
  longitude: number;
  gps_accuracy_meters: number;
  is_mock_location: number;
  selfie_path: string;
  idempotency_key: string;
  related_punch_in_id: string | null;
  created_at: string;
}

function rowToPunch(row: PunchRow): Punch {
  return {
    id: row.id,
    employeeId: row.employee_id,
    siteId: row.site_id,
    type: row.type as PunchType,
    clientTimestamp: row.client_timestamp,
    latitude: row.latitude,
    longitude: row.longitude,
    gpsAccuracyMeters: row.gps_accuracy_meters,
    isMockLocation: row.is_mock_location === 1,
    selfiePath: row.selfie_path,
    idempotencyKey: asIdempotencyKey(row.idempotency_key),
    relatedPunchInId: row.related_punch_in_id,
    createdAt: row.created_at,
  };
}

export class SqlitePunchRepository implements PunchRepository {
  constructor(private readonly db: SqlDatabase) {}

  async insert(punch: Punch): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO punches
         (id, employee_id, site_id, type, client_timestamp, latitude, longitude,
          gps_accuracy_meters, is_mock_location, selfie_path, idempotency_key,
          related_punch_in_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        punch.id,
        punch.employeeId,
        punch.siteId,
        punch.type,
        punch.clientTimestamp,
        punch.latitude,
        punch.longitude,
        punch.gpsAccuracyMeters,
        punch.isMockLocation ? 1 : 0,
        punch.selfiePath,
        punch.idempotencyKey,
        punch.relatedPunchInId,
        punch.createdAt,
      ],
    );
  }

  async getById(id: string): Promise<Punch | null> {
    const row = await this.db.getFirstAsync<PunchRow>(
      'SELECT * FROM punches WHERE id = ?;',
      [id],
    );
    return row ? rowToPunch(row) : null;
  }

  async findOpenPunchIn(employeeId: string): Promise<Punch | null> {
    const row = await this.db.getFirstAsync<PunchRow>(
      `SELECT p.* FROM punches p
       WHERE p.employee_id = ?
         AND p.type = 'IN'
         AND NOT EXISTS (
           SELECT 1 FROM punches o
           WHERE o.related_punch_in_id = p.id
         )
       ORDER BY p.client_timestamp DESC
       LIMIT 1;`,
      [employeeId],
    );
    return row ? rowToPunch(row) : null;
  }

  async listByEmployee(employeeId: string): Promise<readonly Punch[]> {
    const rows = await this.db.getAllAsync<PunchRow>(
      'SELECT * FROM punches WHERE employee_id = ? ORDER BY client_timestamp ASC;',
      [employeeId],
    );
    return rows.map(rowToPunch);
  }
}
