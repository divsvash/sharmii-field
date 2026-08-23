import type { SqlDatabase } from './SqlDatabase';
import type {
  Incident,
  IncidentPhoto,
  IncidentSeverity,
} from '../../domain/incident/Incident';
import type {
  IncidentPhotoRepository,
  IncidentRepository,
} from '../../domain/incident/IncidentRepository';
import { asIdempotencyKey } from '../../domain/sync/OutboxItem';

interface IncidentRow {
  id: string;
  employee_id: string;
  category: string;
  description: string;
  severity: string;
  client_timestamp: string;
  idempotency_key: string;
  created_at: string;
}

interface IncidentPhotoRow {
  id: string;
  incident_id: string;
  file_path: string;
  idempotency_key: string;
  created_at: string;
}

function rowToIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    employeeId: row.employee_id,
    category: row.category,
    description: row.description,
    severity: row.severity as IncidentSeverity,
    clientTimestamp: row.client_timestamp,
    idempotencyKey: asIdempotencyKey(row.idempotency_key),
    createdAt: row.created_at,
  };
}

function rowToPhoto(row: IncidentPhotoRow): IncidentPhoto {
  return {
    id: row.id,
    incidentId: row.incident_id,
    filePath: row.file_path,
    idempotencyKey: asIdempotencyKey(row.idempotency_key),
    createdAt: row.created_at,
  };
}

export class SqliteIncidentRepository implements IncidentRepository {
  constructor(private readonly db: SqlDatabase) {}

  async insert(incident: Incident): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO incidents
         (id, employee_id, category, description, severity, client_timestamp, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        incident.id,
        incident.employeeId,
        incident.category,
        incident.description,
        incident.severity,
        incident.clientTimestamp,
        incident.idempotencyKey,
        incident.createdAt,
      ],
    );
  }

  async getById(id: string): Promise<Incident | null> {
    const row = await this.db.getFirstAsync<IncidentRow>(
      'SELECT * FROM incidents WHERE id = ?;',
      [id],
    );
    return row ? rowToIncident(row) : null;
  }

  async listByEmployee(employeeId: string): Promise<readonly Incident[]> {
    const rows = await this.db.getAllAsync<IncidentRow>(
      'SELECT * FROM incidents WHERE employee_id = ? ORDER BY client_timestamp ASC;',
      [employeeId],
    );
    return rows.map(rowToIncident);
  }
}

export class SqliteIncidentPhotoRepository implements IncidentPhotoRepository {
  constructor(private readonly db: SqlDatabase) {}

  async insert(photo: IncidentPhoto): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO incident_photos
         (id, incident_id, file_path, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      [photo.id, photo.incidentId, photo.filePath, photo.idempotencyKey, photo.createdAt],
    );
  }

  async listByIncident(incidentId: string): Promise<readonly IncidentPhoto[]> {
    const rows = await this.db.getAllAsync<IncidentPhotoRow>(
      'SELECT * FROM incident_photos WHERE incident_id = ? ORDER BY created_at ASC;',
      [incidentId],
    );
    return rows.map(rowToPhoto);
  }
}
