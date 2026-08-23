import type { Migration } from '../Migration';

/**
 * Additive-only migration — the project has moved past the pre-release
 * "edit migration 0001 in place" exception; from here on, every schema
 * change gets its own migration.
 *
 * Adds the single column retry scheduling needs: the next time a
 * FAILED_RETRYABLE item may be attempted again, computed by
 * OutboxDispatcher via RetryPolicy.nextDelayMs and enforced by
 * OutboxDispatchSelector. Nullable, no default needed — ADD COLUMN with
 * no NOT NULL constraint is safe regardless of existing rows.
 */
export const addNextAttemptAtMigration: Migration = {
  version: 2,
  description: 'outbox_items.next_attempt_at for retry scheduling',
  up: async (db) => {
    await db.execAsync(`
      ALTER TABLE outbox_items ADD COLUMN next_attempt_at TEXT;
    `);
  },
};
