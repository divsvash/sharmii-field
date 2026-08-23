import { asIdempotencyKey } from '../../../src/domain/sync/OutboxItem';
import {
  createIncidentPhoto,
  IncidentValidationError,
  MAX_INCIDENT_PHOTOS,
  type Incident,
} from '../../../src/domain/incident/Incident';

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'incident-1',
    employeeId: 'emp-1',
    category: 'SAFETY',
    description: 'Slippery floor near entrance',
    severity: 'MEDIUM',
    clientTimestamp: '2026-08-18T09:00:00.000Z',
    idempotencyKey: asIdempotencyKey('idem-incident-1'),
    createdAt: '2026-08-18T09:00:00.500Z',
    ...overrides,
  };
}

describe('createIncidentPhoto', () => {
  it('creates a valid photo referencing its incident (invariant 4)', () => {
    const incident = makeIncident();

    const photo = createIncidentPhoto({
      id: 'photo-1',
      incident,
      filePath: 'file:///data/incidents/photo-1.jpg',
      idempotencyKey: asIdempotencyKey('idem-photo-1'),
      createdAt: '2026-08-18T09:00:01.000Z',
      existingPhotoCount: 0,
    });

    expect(photo.incidentId).toBe(incident.id);
    expect(photo.filePath).toBe('file:///data/incidents/photo-1.jpg');
  });

  it('rejects a base64 data URI as filePath (invariant 7)', () => {
    const incident = makeIncident();

    expect(() =>
      createIncidentPhoto({
        id: 'photo-2',
        incident,
        filePath: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        idempotencyKey: asIdempotencyKey('idem-photo-2'),
        createdAt: '2026-08-18T09:00:01.000Z',
        existingPhotoCount: 0,
      }),
    ).toThrow(IncidentValidationError);
  });

  it('rejects an empty filePath', () => {
    const incident = makeIncident();

    expect(() =>
      createIncidentPhoto({
        id: 'photo-3',
        incident,
        filePath: '   ',
        idempotencyKey: asIdempotencyKey('idem-photo-3'),
        createdAt: '2026-08-18T09:00:01.000Z',
        existingPhotoCount: 0,
      }),
    ).toThrow(IncidentValidationError);
  });

  it('allows exactly MAX_INCIDENT_PHOTOS photos', () => {
    const incident = makeIncident();

    expect(() =>
      createIncidentPhoto({
        id: 'photo-4',
        incident,
        filePath: 'file:///data/incidents/photo-4.jpg',
        idempotencyKey: asIdempotencyKey('idem-photo-4'),
        createdAt: '2026-08-18T09:00:01.000Z',
        existingPhotoCount: MAX_INCIDENT_PHOTOS - 1,
      }),
    ).not.toThrow();
  });

  it('rejects a 4th photo on the same incident', () => {
    const incident = makeIncident();

    expect(() =>
      createIncidentPhoto({
        id: 'photo-5',
        incident,
        filePath: 'file:///data/incidents/photo-5.jpg',
        idempotencyKey: asIdempotencyKey('idem-photo-5'),
        createdAt: '2026-08-18T09:00:01.000Z',
        existingPhotoCount: MAX_INCIDENT_PHOTOS,
      }),
    ).toThrow(IncidentValidationError);
  });
});
