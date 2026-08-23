import type { Migration } from '../Migration';
import { initialSchemaMigration } from './0001_initial_schema';
import { addNextAttemptAtMigration } from './0002_add_next_attempt_at';

/** Ordered by version. Add new migrations here, never edit an applied one. */
export const migrations: readonly Migration[] = [initialSchemaMigration, addNextAttemptAtMigration];
