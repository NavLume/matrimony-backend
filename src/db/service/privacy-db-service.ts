import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { PrivacyRepository } from '../raw/repository/privacy-repository.js';

/** Reading a person's consents and data, bound to one open transaction, so a copy and its event are kept together. */
export interface PrivacyUnit {
  subject: PrivacyRepositoryBound['subject'];
  profileOf: PrivacyRepositoryBound['profileOf'];
  erasure: PrivacyRepositoryBound['erasure'];
  consents: PrivacyRepositoryBound['consents'];
  collect: PrivacyRepositoryBound['collect'];
  appendEvent(event: WorkflowEvent): Promise<void>;
}

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type PrivacyRepositoryBound = { [K in keyof PrivacyRepository]: Bound<PrivacyRepository[K]> };

export class PrivacyDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: PrivacyRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: PrivacyUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): PrivacyUnit {
    const repo = this.repository;
    return {
      subject: (...a) => repo.subject(tx, ...a),
      profileOf: (...a) => repo.profileOf(tx, ...a),
      erasure: (...a) => repo.erasure(tx, ...a),
      consents: (...a) => repo.consents(tx, ...a),
      collect: (...a) => repo.collect(tx, ...a),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
