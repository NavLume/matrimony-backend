import type { Database, Transaction } from '../config/database.js';
import type { JourneyRepository } from '../raw/repository/journey-repository.js';

/** What the journey may read, bound to one open transaction (read only, so no events). */
export interface JourneyUnit {
  profileById: JourneyRepositoryBound['profileById'];
  ownProfile: JourneyRepositoryBound['ownProfile'];
  journey: JourneyRepositoryBound['journey'];
}

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type JourneyRepositoryBound = { [K in keyof JourneyRepository]: Bound<JourneyRepository[K]> };

export class JourneyDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: JourneyRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: JourneyUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): JourneyUnit {
    const repo = this.repository;
    return {
      profileById: (...a) => repo.profileById(tx, ...a),
      ownProfile: (...a) => repo.ownProfile(tx, ...a),
      journey: (...a) => repo.journey(tx, ...a),
    };
  }
}
