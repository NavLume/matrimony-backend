import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import { notifyDecided, notifyReviewers } from '../raw/repository/notice.js';
import type { VerificationRepository } from '../raw/repository/verification-repository.js';

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bound2<T> = { [K in keyof T]: Bound<T[K]> };
type Repo = Bound2<VerificationRepository>;

/**
 * Everything verification may do, bound to one open transaction, so a request, the mark on the
 * profile, its inbox lines and its event are stored together.
 */
export interface VerificationUnit extends Repo {
  tellReviewers(agencyId: string, profileId: string, submitterId: string): Promise<void>;
  tellDecided(
    agencyId: string,
    profileId: string,
    submitterId: string,
    deciderId: string,
    decision: 'approved' | 'rejected' | 'withdrawn',
  ): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class VerificationDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: VerificationRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: VerificationUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): VerificationUnit {
    const repo = this.repository;
    return {
      profileById: (...a) => repo.profileById(tx, ...a),
      ownProfile: (...a) => repo.ownProfile(tx, ...a),
      latest: (...a) => repo.latest(tx, ...a),
      byId: (...a) => repo.byId(tx, ...a),
      insert: (...a) => repo.insert(tx, ...a),
      mimeOf: (...a) => repo.mimeOf(tx, ...a),
      decide: (...a) => repo.decide(tx, ...a),
      markFileRemoved: (...a) => repo.markFileRemoved(tx, ...a),
      setVerified: (...a) => repo.setVerified(tx, ...a),
      waiting: (...a) => repo.waiting(tx, ...a),
      tellReviewers: (agencyId, profileId, submitterId) =>
        notifyReviewers(tx, agencyId, profileId, submitterId, 'verification'),
      tellDecided: (agencyId, profileId, submitterId, deciderId, decision) =>
        notifyDecided(tx, agencyId, profileId, submitterId, deciderId, 'verification', decision),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
