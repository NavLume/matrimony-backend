import type { CvRecord } from '../../bo/cv.js';
import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { CvProfile, CvRepository } from '../raw/repository/cv-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/**
 * Everything the CV workflow may do, bound to one open transaction. The rules run between these
 * calls, so a replacement cannot race another and an event is stored together with its change.
 */
export interface CvUnit {
  ownProfile(agencyId: string, ownerId: string, lock: boolean): Promise<CvProfile | null>;
  profileById(agencyId: string, profileId: string, lock: boolean): Promise<CvProfile | null>;
  live(agencyId: string, profileId: string): Promise<CvRecord[]>;
  published(agencyId: string, profileId: string): Promise<CvRecord | null>;
  insert(
    agencyId: string,
    input: {
      id: string;
      profileId: string;
      storageKey: string;
      fileName: string;
      byteSize: number;
      status: 'pending' | 'published';
      uploadedBy: string;
    },
  ): Promise<void>;
  markRemoved(agencyId: string, id: string): Promise<void>;
  decide(
    agencyId: string,
    id: string,
    approve: boolean,
    reviewerId: string,
    notes: string | null,
  ): Promise<boolean>;
  accepted(agencyId: string, a: string, b: string): Promise<boolean>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class CvDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: CvRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: CvUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): CvUnit {
    const repo = this.repository;
    return {
      ownProfile: (agencyId, ownerId, lock) => repo.ownProfile(tx, agencyId, ownerId, lock),
      profileById: (agencyId, profileId, lock) => repo.profileById(tx, agencyId, profileId, lock),
      live: (agencyId, profileId) => repo.live(tx, agencyId, profileId),
      published: (agencyId, profileId) => repo.published(tx, agencyId, profileId),
      insert: (agencyId, input) => repo.insert(tx, agencyId, input),
      markRemoved: (agencyId, id) => repo.markRemoved(tx, agencyId, id),
      decide: (agencyId, id, approve, reviewerId, notes) =>
        repo.decide(tx, agencyId, id, approve, reviewerId, notes),
      accepted: (agencyId, a, b) => repo.accepted(tx, agencyId, a, b),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
