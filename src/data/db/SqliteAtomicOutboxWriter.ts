import type { SqlDatabase } from './SqlDatabase';
import type { Punch } from '../../domain/attendance/Punch';
import type { Incident, IncidentPhoto } from '../../domain/incident/Incident';
import type { AtomicOutboxWriter } from '../../domain/sync/AtomicOutboxWriter';
import type { NewOutboxItem } from '../../domain/sync/OutboxItem';
import { SqliteIncidentPhotoRepository, SqliteIncidentRepository } from './SqliteIncidentRepository';
import { SqliteOutboxRepository } from './SqliteOutboxRepository';
import { SqlitePunchRepository } from './SqlitePunchRepository';

/**
 * Concrete atomicity guarantee for invariant 1.
 *
 * `SqlDatabase.withTransactionAsync(callback)` wraps every statement run
 * against `this.db` during that callback in BEGIN/COMMIT, and rolls back on
 * a thrown error (see SqlDatabase.ts for the contract; ExpoSqlDatabase and
 * the test-only NodeSqlDatabase both implement it against a real engine).
 * Delegating to the plain PunchRepository/IncidentRepository/OutboxRepository
 * here — instead of hand-writing SQL a second time — is safe specifically
 * because every repository used below is constructed on this same `db`
 * instance, and both calls happen inside one callback: no repository opens
 * a transaction of its own, so there is exactly one BEGIN/COMMIT per method
 * call here.
 *
 * The method's promise resolves only once `withTransactionAsync` resolves,
 * i.e. only after COMMIT. A caller that awaits recordPunch() before
 * updating UI state cannot show "queued" before the write is durable.
 */
export class SqliteAtomicOutboxWriter implements AtomicOutboxWriter {
  private readonly punchRepo: SqlitePunchRepository;
  private readonly incidentRepo: SqliteIncidentRepository;
  private readonly photoRepo: SqliteIncidentPhotoRepository;
  private readonly outboxRepo: SqliteOutboxRepository;

  constructor(private readonly db: SqlDatabase) {
    this.punchRepo = new SqlitePunchRepository(db);
    this.incidentRepo = new SqliteIncidentRepository(db);
    this.photoRepo = new SqliteIncidentPhotoRepository(db);
    this.outboxRepo = new SqliteOutboxRepository(db);
  }

  async recordPunch(punch: Punch, outboxItem: NewOutboxItem): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.punchRepo.insert(punch);
      await this.outboxRepo.insert(outboxItem);
    });
  }

  async recordIncident(incident: Incident, outboxItem: NewOutboxItem): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.incidentRepo.insert(incident);
      await this.outboxRepo.insert(outboxItem);
    });
  }

  async recordIncidentPhoto(photo: IncidentPhoto, outboxItem: NewOutboxItem): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.photoRepo.insert(photo);
      await this.outboxRepo.insert(outboxItem);
    });
  }
}
