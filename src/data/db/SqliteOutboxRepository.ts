import type { SqlDatabase } from './SqlDatabase';
import {
  asIdempotencyKey,
  type NewOutboxItem,
  type OutboxItem,
  type OutboxOperation,
  type OutboxStatus,
} from '../../domain/sync/OutboxItem';
import type { OutboxRepository } from '../../domain/sync/OutboxRepository';
import {
  deserializeSyncError,
  serializeSyncError,
  type SyncError,
} from '../../domain/sync/SyncError';

interface OutboxRow {
  id: string;
  operation: string;
  entity_id: string;
  idempotency_key: string;
  depends_on_outbox_id: string | null;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToOutboxItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    operation: row.operation as OutboxOperation,
    entityId: row.entity_id,
    idempotencyKey: asIdempotencyKey(row.idempotency_key),
    dependsOnOutboxId: row.depends_on_outbox_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    lastError: row.last_error ? deserializeSyncError(row.last_error) : null,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly db: SqlDatabase) {}

  async insert(item: NewOutboxItem): Promise<void> {
    const now = new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO outbox_items
         (id, operation, entity_id, idempotency_key, depends_on_outbox_id,
          payload, status, attempts, last_error, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, NULL, ?, ?);`,
      [
        item.id,
        item.operation,
        item.entityId,
        item.idempotencyKey,
        item.dependsOnOutboxId,
        JSON.stringify(item.payload),
        item.createdAt,
        now,
      ],
    );
  }

  async getById(id: string): Promise<OutboxItem | null> {
    const row = await this.db.getFirstAsync<OutboxRow>(
      'SELECT * FROM outbox_items WHERE id = ?;',
      [id],
    );
    return row ? rowToOutboxItem(row) : null;
  }

  async getByEntityId(entityId: string): Promise<OutboxItem | null> {
    const row = await this.db.getFirstAsync<OutboxRow>(
      'SELECT * FROM outbox_items WHERE entity_id = ?;',
      [entityId],
    );
    return row ? rowToOutboxItem(row) : null;
  }

  async listSyncable(): Promise<readonly OutboxItem[]> {
    const rows = await this.db.getAllAsync<OutboxRow>(
      `SELECT o.* FROM outbox_items o
       WHERE o.status IN ('PENDING', 'FAILED_RETRYABLE')
         AND (
           o.depends_on_outbox_id IS NULL
           OR EXISTS (
             SELECT 1 FROM outbox_items dep
             WHERE dep.id = o.depends_on_outbox_id AND dep.status = 'SYNCED'
           )
         )
       ORDER BY o.created_at ASC;`,
    );
    return rows.map(rowToOutboxItem);
  }

  async listAll(): Promise<readonly OutboxItem[]> {
    const rows = await this.db.getAllAsync<OutboxRow>(
      'SELECT * FROM outbox_items ORDER BY created_at ASC;',
    );
    return rows.map(rowToOutboxItem);
  }

  async markInFlight(id: string): Promise<void> {
    await this.db.runAsync(
      `UPDATE outbox_items SET status = 'IN_FLIGHT', updated_at = ? WHERE id = ?;`,
      [new Date().toISOString(), id],
    );
  }

  async markSynced(id: string): Promise<void> {
    await this.db.runAsync(
      `UPDATE outbox_items SET status = 'SYNCED', updated_at = ? WHERE id = ?;`,
      [new Date().toISOString(), id],
    );
  }

  async markFailed(
    id: string,
    error: SyncError,
    status: Extract<OutboxStatus, 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'>,
    nextAttemptAt: string | null,
  ): Promise<void> {
    await this.db.runAsync(
      `UPDATE outbox_items
       SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE id = ?;`,
      [status, serializeSyncError(error), nextAttemptAt, new Date().toISOString(), id],
    );
  }

  async recoverInFlightItems(): Promise<number> {
    const now = new Date().toISOString();
    // attempts is deliberately NOT incremented here: we don't know whether
    // a real network attempt occurred before the process died, so this
    // isn't counted as a completed attempt — only as a status correction.
    // next_attempt_at is cleared to NULL so the recovered item is
    // immediately eligible rather than inheriting a stale future value
    // from whatever failure preceded this IN_FLIGHT attempt.
    const recoveryError: SyncError = {
      kind: 'retryable',
      reason: 'PROCESS_INTERRUPTED',
      message: 'Recovered after process death; previous attempt outcome unknown',
      occurredAt: now,
    };

    const result = await this.db.runAsync(
      `UPDATE outbox_items
       SET status = 'FAILED_RETRYABLE', last_error = ?, next_attempt_at = NULL, updated_at = ?
       WHERE status = 'IN_FLIGHT';`,
      [serializeSyncError(recoveryError), now],
    );

    return result.changes;
  }
}
