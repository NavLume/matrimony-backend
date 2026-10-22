import type { Database } from '../config/database.js';
import type { FunnelRepository } from '../raw/repository/funnel-repository.js';

/** Reading when people reached each stage of the funnel, in one transaction. */
export class FunnelDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: FunnelRepository,
  ) {}

  people(
    agencyId: string,
    scope: { from: string | null; to: string | null; agentId: string | null },
  ) {
    return this.db.transaction(agencyId, (tx) => this.repository.people(tx, agencyId, scope));
  }
}
