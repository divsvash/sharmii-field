import type { Punch } from './Punch';

/**
 * Domain-side port. The concrete implementation lives in data/db and is
 * swappable (invariant 9) — domain and feature code depend only on this
 * interface, never on expo-sqlite directly.
 */
export interface PunchRepository {
  insert(punch: Punch): Promise<void>;
  getById(id: string): Promise<Punch | null>;
  /** Most recent punch-in for an employee that has no matching punch-out yet. */
  findOpenPunchIn(employeeId: string): Promise<Punch | null>;
  listByEmployee(employeeId: string): Promise<readonly Punch[]>;
}
