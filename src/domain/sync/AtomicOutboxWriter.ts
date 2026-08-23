import type { Punch } from '../attendance/Punch';
import type { Incident, IncidentPhoto } from '../incident/Incident';
import type { NewOutboxItem } from './OutboxItem';

/**
 * Invariant 1: offline mutations must be durable before the UI treats them
 * as queued. This is the atomic "persist entity + enqueue outbox" boundary.
 *
 * Each method commits its entity row and its outbox row in a single
 * transaction: either both exist afterward, or neither does. The returned
 * promise resolves only after that transaction commits, so a caller that
 * awaits one of these methods and then shows a "queued" state to the user
 * cannot do so before the write is durable. A process death before commit
 * leaves nothing; a process death after commit leaves both rows — there is
 * no reachable state with an entity but no outbox intent for it.
 *
 * This replaces an earlier generic DurableWriter/TransactionScope port that
 * described transactionality without enforcing it end to end. Three narrow
 * methods — one per write path that actually needs this guarantee — are
 * used here instead of one generic `runInTransaction(work)` escape hatch:
 * a generic version would let arbitrary logic run inside a transaction,
 * which is the "large transaction abstraction" this phase avoids. Nothing
 * outside data/db needs a fourth variant yet; add one only when a fourth
 * atomic write path is actually needed.
 */
export interface AtomicOutboxWriter {
  recordPunch(punch: Punch, outboxItem: NewOutboxItem): Promise<void>;
  recordIncident(incident: Incident, outboxItem: NewOutboxItem): Promise<void>;
  recordIncidentPhoto(photo: IncidentPhoto, outboxItem: NewOutboxItem): Promise<void>;
}
