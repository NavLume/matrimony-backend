import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { ServiceTermsRepository } from '../raw/repository/service-terms-repository.js';

/** Everything the terms of a service may do, bound to one open transaction, so a change and its event are kept together. */
export interface ServiceTermsUnit {
  profileById: ServiceTermsRepositoryBound['profileById'];
  ownProfile: ServiceTermsRepositoryBound['ownProfile'];
  versions: ServiceTermsRepositoryBound['versions'];
  insert: ServiceTermsRepositoryBound['insert'];
  acknowledge: ServiceTermsRepositoryBound['acknowledge'];
  appendEvent(event: WorkflowEvent): Promise<void>;
}

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type ServiceTermsRepositoryBound = {
  [K in keyof ServiceTermsRepository]: Bound<ServiceTermsRepository[K]>;
};

export class ServiceTermsDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: ServiceTermsRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: ServiceTermsUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ServiceTermsUnit {
    const repo = this.repository;
    return {
      profileById: (...a) => repo.profileById(tx, ...a),
      ownProfile: (...a) => repo.ownProfile(tx, ...a),
      versions: (...a) => repo.versions(tx, ...a),
      insert: (...a) => repo.insert(tx, ...a),
      acknowledge: (...a) => repo.acknowledge(tx, ...a),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
