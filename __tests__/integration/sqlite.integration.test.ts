import { createPunchIn } from '../../src/domain/attendance/Punch';
import { asIdempotencyKey, type NewOutboxItem } from '../../src/domain/sync/OutboxItem';
import { runMigrations } from '../../src/data/db/Migration';
import { migrations } from '../../src/data/db/migrations';
import type { SqlDatabase } from '../../src/data/db/SqlDatabase';
import { SqliteAtomicOutboxWriter } from '../../src/data/db/SqliteAtomicOutboxWriter';
import { SqliteOutboxRepository } from '../../src/data/db/SqliteOutboxRepository';
import { SqlitePunchRepository } from '../../src/data/db/SqlitePunchRepository';
import { createNodeSqliteTestDatabase } from '../helpers/NodeSqliteTestDatabase';

/**
 * These tests run the ACTUAL production repository / writer / migration
 * code (src/data/db/*) against a real, running SQLite engine (Node's
 * built-in node:sqlite, via the test-only adapter in
 * __tests__/helpers/NodeSqliteTestDatabase.ts). expo-sqlite's native
 * binding cannot load in a plain Node process, so this is what makes the
 * transaction/rollback claims verifiable in this sandbox rather than
 * merely asserted by inspection.
 */

async function freshDb(): Promise<SqlDatabase> {
  const db = createNodeSqliteTestDatabase();
  await runMigrations(db, migrations);
  return db;
}

function validPunchIn(overrides: Partial<Parameters<typeof createPunchIn>[0]> = {}) {
  return createPunchIn({
    id: 'punch-1',
    employeeId: 'emp-1',
    siteId: 'site-1',
    clientTimestamp: '2026-08-19T09:00:00.000Z',
    latitude: 28.9845,
    longitude: 77.7064,
    gpsAccuracyMeters: 6.2,
    isMockLocation: false,
    selfiePath: 'file:///data/selfies/punch-1.jpg',
    idempotencyKey: asIdempotencyKey('idem-punch-1'),
    createdAt: '2026-08-19T09:00:00.500Z',
    ...overrides,
  });
}

function outboxItemFor(punchId: string, idempotencyKey: string): NewOutboxItem {
  return {
    id: `outbox-${punchId}`,
    operation: 'PUNCH_IN',
    entityId: punchId,
    idempotencyKey: asIdempotencyKey(idempotencyKey),
    dependsOnOutboxId: null,
    payload: { punchId },
    createdAt: '2026-08-19T09:00:00.600Z',
  };
}

describe('migrations against a real SQLite engine', () => {
  it('creates all four tables and records the applied version', async () => {
    const db = await freshDb();

    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
    );
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toEqual(
      expect.arrayContaining(['punches', 'incidents', 'incident_photos', 'outbox_items']),
    );

    const applied = await db.getAllAsync<{ version: number }>(
      'SELECT version FROM schema_migrations;',
    );
    expect(applied).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('is idempotent — running migrations again does not error or duplicate', async () => {
    const db = await freshDb();

    await expect(runMigrations(db, migrations)).resolves.not.toThrow();

    const applied = await db.getAllAsync<{ version: number }>(
      'SELECT version FROM schema_migrations;',
    );
    expect(applied).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('enforces the punch type CHECK constraint for real', async () => {
    const db = await freshDb();

    await expect(
      db.runAsync(
        `INSERT INTO punches
           (id, employee_id, site_id, type, client_timestamp, latitude, longitude,
            gps_accuracy_meters, is_mock_location, selfie_path, idempotency_key,
            related_punch_in_id, created_at)
         VALUES ('p1','e1','s1','SIDEWAYS','2026-08-19T09:00:00.000Z',0,0,1,0,
                 'file:///x.jpg','idem-x',NULL,'2026-08-19T09:00:00.000Z');`,
      ),
    ).rejects.toThrow();

    const rows = await db.getAllAsync('SELECT * FROM punches;');
    expect(rows).toEqual([]);
  });
});

describe('foreign key enforcement against a real SQLite engine', () => {
  it('rejects a punch whose related_punch_in_id references a nonexistent punch', async () => {
    const db = await freshDb();

    await expect(
      db.runAsync(
        `INSERT INTO punches
           (id, employee_id, site_id, type, client_timestamp, latitude, longitude,
            gps_accuracy_meters, is_mock_location, selfie_path, idempotency_key,
            related_punch_in_id, created_at)
         VALUES ('p-out','e1','s1','OUT','2026-08-19T09:00:00.000Z',0,0,1,0,
                 'file:///out.jpg','idem-p-out','does-not-exist','2026-08-19T09:00:00.000Z');`,
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);

    const rows = await db.getAllAsync('SELECT * FROM punches;');
    expect(rows).toEqual([]);
  });

  it('rejects an incident photo whose incident_id references a nonexistent incident', async () => {
    const db = await freshDb();

    await expect(
      db.runAsync(
        `INSERT INTO incident_photos (id, incident_id, file_path, idempotency_key, created_at)
         VALUES ('photo-1','does-not-exist','file:///photo.jpg','idem-photo-1','2026-08-19T09:00:00.000Z');`,
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);

    const rows = await db.getAllAsync('SELECT * FROM incident_photos;');
    expect(rows).toEqual([]);
  });

  it('rejects an outbox item whose depends_on_outbox_id references a nonexistent outbox item', async () => {
    const db = await freshDb();
    const outboxRepo = new SqliteOutboxRepository(db);

    await expect(
      outboxRepo.insert({
        id: 'outbox-orphan',
        operation: 'PUNCH_OUT',
        entityId: 'punch-x',
        idempotencyKey: asIdempotencyKey('idem-orphan'),
        dependsOnOutboxId: 'does-not-exist',
        payload: {},
        createdAt: '2026-08-19T09:00:00.000Z',
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);

    const rows = await outboxRepo.listAll();
    expect(rows).toEqual([]);
  });

  it('accepts a punch-out whose related_punch_in_id references a real, already-inserted punch', async () => {
    const db = await freshDb();
    const punchRepo = new SqlitePunchRepository(db);

    const punchIn = validPunchIn({ id: 'punch-fk-in', idempotencyKey: asIdempotencyKey('idem-fk-in') });
    await punchRepo.insert(punchIn);

    await expect(
      db.runAsync(
        `INSERT INTO punches
           (id, employee_id, site_id, type, client_timestamp, latitude, longitude,
            gps_accuracy_meters, is_mock_location, selfie_path, idempotency_key,
            related_punch_in_id, created_at)
         VALUES ('punch-fk-out','emp-1','site-1','OUT','2026-08-19T17:00:00.000Z',0,0,1,0,
                 'file:///out.jpg','idem-fk-out','punch-fk-in','2026-08-19T17:00:00.000Z');`,
      ),
    ).resolves.not.toThrow();

    const rows = await db.getAllAsync('SELECT * FROM punches;');
    expect(rows).toHaveLength(2);
  });
});

describe('SqliteAtomicOutboxWriter — commit path (real transaction)', () => {
  it('persists both the punch row and the outbox row after recordPunch resolves', async () => {
    const db = await freshDb();
    const writer = new SqliteAtomicOutboxWriter(db);
    const punchRepo = new SqlitePunchRepository(db);
    const outboxRepo = new SqliteOutboxRepository(db);

    const punch = validPunchIn();
    const outboxItem = outboxItemFor(punch.id, 'idem-outbox-1');

    await writer.recordPunch(punch, outboxItem);

    const persistedPunch = await punchRepo.getById(punch.id);
    const persistedOutbox = await outboxRepo.getByEntityId(punch.id);

    expect(persistedPunch).not.toBeNull();
    expect(persistedPunch?.id).toBe(punch.id);
    expect(persistedOutbox).not.toBeNull();
    expect(persistedOutbox?.status).toBe('PENDING');
    expect(persistedOutbox?.entityId).toBe(punch.id);
  });
});

describe('SqliteAtomicOutboxWriter — deterministic rollback proof', () => {
  it(
    'mechanism proof: begin transaction, insert entity, fail before outbox insert, ' +
      'rollback, neither row exists',
    async () => {
      const db = await freshDb();
      const punchRepo = new SqlitePunchRepository(db);
      const punch = validPunchIn();

      await expect(
        db.withTransactionAsync(async () => {
          // Step 2: insert entity, inside the transaction.
          await punchRepo.insert(punch);

          // Step 3: deliberately fail before the outbox insert ever runs.
          throw new Error('deliberate failure before outbox insert');

          // (unreachable — outbox insert intentionally never happens)
        }),
        // Step 4: withTransactionAsync's documented contract is to
        // ROLLBACK when the callback throws, then rethrow.
      ).rejects.toThrow('deliberate failure before outbox insert');

      // Step 5: verify neither row exists.
      const punchRows = await db.getAllAsync('SELECT * FROM punches;');
      const outboxRows = await db.getAllAsync('SELECT * FROM outbox_items;');
      expect(punchRows).toEqual([]);
      expect(outboxRows).toEqual([]);
    },
  );

  it('realistic proof: a genuine UNIQUE constraint failure on the outbox insert rolls back the already-inserted punch row', async () => {
    const db = await freshDb();
    const writer = new SqliteAtomicOutboxWriter(db);
    const punchRepo = new SqlitePunchRepository(db);
    const outboxRepo = new SqliteOutboxRepository(db);

    // Pre-seed an outbox row whose idempotency_key we will collide with —
    // this is a real UNIQUE constraint the schema enforces, not a
    // manually-thrown error.
    const existingPunch = validPunchIn({
      id: 'punch-existing',
      idempotencyKey: asIdempotencyKey('idem-existing'),
    });
    const existingOutboxItem = outboxItemFor('punch-existing', 'idem-shared-outbox-key');
    await writer.recordPunch(existingPunch, existingOutboxItem);

    // Attempt a second, different punch whose outbox item reuses the same
    // idempotency key. The punch insert (statement 1) will succeed inside
    // the transaction; the outbox insert (statement 2) will violate the
    // UNIQUE constraint on outbox_items.idempotency_key and throw.
    const conflictingPunch = validPunchIn({
      id: 'punch-conflicting',
      idempotencyKey: asIdempotencyKey('idem-punch-conflicting'),
    });
    const conflictingOutboxItem = outboxItemFor('punch-conflicting', 'idem-shared-outbox-key');

    await expect(writer.recordPunch(conflictingPunch, conflictingOutboxItem)).rejects.toThrow();

    // The punch row from the failed transaction must NOT exist —
    // rolled back together with the outbox insert that failed.
    const rolledBackPunch = await punchRepo.getById('punch-conflicting');
    expect(rolledBackPunch).toBeNull();

    // The pre-existing, successfully-committed rows from the first
    // transaction are untouched.
    const survivingPunch = await punchRepo.getById('punch-existing');
    const survivingOutbox = await outboxRepo.getByEntityId('punch-existing');
    expect(survivingPunch).not.toBeNull();
    expect(survivingOutbox).not.toBeNull();

    // Exactly one outbox row exists total — the second insert never
    // committed a duplicate or a partial row.
    const allOutboxRows = await outboxRepo.listAll();
    expect(allOutboxRows).toHaveLength(1);
  });
});

describe('process-death recovery against a real SQLite engine', () => {
  it('recovers an IN_FLIGHT row to FAILED_RETRYABLE on startup and it becomes syncable again', async () => {
    const db = await freshDb();
    const writer = new SqliteAtomicOutboxWriter(db);
    const outboxRepo = new SqliteOutboxRepository(db);

    const punch = validPunchIn();
    const outboxItem = outboxItemFor(punch.id, 'idem-outbox-recovery');
    await writer.recordPunch(punch, outboxItem);

    // Simulate a sync engine having dispatched the item, then the process
    // dying before the response was recorded.
    await outboxRepo.markInFlight(outboxItem.id);
    const inFlight = await outboxRepo.getById(outboxItem.id);
    expect(inFlight?.status).toBe('IN_FLIGHT');

    const recoveredCount = await outboxRepo.recoverInFlightItems();
    expect(recoveredCount).toBe(1);

    const recovered = await outboxRepo.getById(outboxItem.id);
    expect(recovered?.status).toBe('FAILED_RETRYABLE');
    expect(recovered?.lastError?.kind).toBe('retryable');

    const syncable = await outboxRepo.listSyncable();
    expect(syncable.map((i) => i.id)).toEqual([outboxItem.id]);
  });
});
