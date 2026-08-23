import type { Incident, IncidentPhoto } from './Incident';

export interface IncidentRepository {
  insert(incident: Incident): Promise<void>;
  getById(id: string): Promise<Incident | null>;
  listByEmployee(employeeId: string): Promise<readonly Incident[]>;
}

export interface IncidentPhotoRepository {
  insert(photo: IncidentPhoto): Promise<void>;
  listByIncident(incidentId: string): Promise<readonly IncidentPhoto[]>;
}
