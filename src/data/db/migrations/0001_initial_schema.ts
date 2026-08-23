import type { Migration } from '../Migration';

/**
 * Establishes the four tables this foundation phase is scoped to. No auth
 * or roster tables yet — those are out of scope per the assignment brief.
 *
 * This migration was edited in place (rather than superseded by 0002) to
 * add the full Punch/Incident field set — acceptable only because nothing
 * has shipped against version 1 of this schema yet. Once this app has a
 * release with real user data, migrations become additive-only: new
 * columns/tables go in a new numbered migration, this file is never
 * touched again.
 *
 * `PRAGMA foreign_keys = ON` is deliberately NOT set here. SQLite treats
 * that pragma as a no-op when issued inside a transaction, and every
 * migration's `up()` runs inside `runMigrations`'s
 * `db.withTransactionAsync(...)` — so a PRAGMA here would silently never
 * take effect. Foreign-key enforcement is enabled once, immediately after
 * the connection opens and before any transaction begins — see
 * openDatabase.ts (production) and NodeSqliteTestDatabase.ts (tests).
 */
export const initialSchemaMigration: Migration = {
  version: 1,
  description: 'punches, incidents, incident_photos, outbox_items',
  up: async (db) => {
    await db.execAsync(`
      -- No sync_status column here, deliberately: outbox_items is the
      -- single source of synchronization-state truth. A future Punch
      -- History UI derives sync state per punch via
      -- outbox_items.entity_id / SqliteOutboxRepository.getByEntityId,
      -- not from a second, independently-mutable status stored here.
      CREATE TABLE punches (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
        client_timestamp TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        gps_accuracy_meters REAL NOT NULL,
        is_mock_location INTEGER NOT NULL CHECK (is_mock_location IN (0,1)),
        selfie_path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        related_punch_in_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (related_punch_in_id) REFERENCES punches(id)
      );

      CREATE INDEX idx_punches_employee ON punches(employee_id);
      CREATE INDEX idx_punches_site ON punches(site_id);

      CREATE TABLE incidents (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        client_timestamp TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_incidents_employee ON incidents(employee_id);

      CREATE TABLE incident_photos (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id)
      );

      -- Max 3 photos/incident is enforced at the domain layer
      -- (createIncidentPhoto), not here — SQLite has no declarative
      -- "count of related rows" constraint short of a trigger, and a
      -- trigger duplicating logic the domain already owns wasn't worth
      -- the added surface for this phase.
      CREATE INDEX idx_photos_incident ON incident_photos(incident_id);

      CREATE TABLE outbox_items (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK (operation IN
          ('PUNCH_IN','PUNCH_OUT','INCIDENT_CREATE','INCIDENT_PHOTO_UPLOAD')),
        entity_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        depends_on_outbox_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('PENDING','IN_FLIGHT','FAILED_RETRYABLE','FAILED_TERMINAL','SYNCED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (depends_on_outbox_id) REFERENCES outbox_items(id)
      );

      CREATE INDEX idx_outbox_status ON outbox_items(status);
      CREATE INDEX idx_outbox_depends_on ON outbox_items(depends_on_outbox_id);
      CREATE INDEX idx_outbox_entity ON outbox_items(entity_id);
    `);
  },
};
