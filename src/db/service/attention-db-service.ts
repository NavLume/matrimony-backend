import type { Database, Transaction } from '../config/database.js';
import type { AttentionRepository } from '../raw/repository/attention-repository.js';

/** What the attention list may read, bound to one open transaction (read only). */
export interface AttentionUnit {
  limits: AttentionRepositoryBound['limits'];
  items: AttentionRepositoryBound['items'];
  agents: AttentionRepositoryBound['agents'];
}

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type AttentionRepositoryBound = { [K in keyof AttentionRepository]: Bound<AttentionRepository[K]> };

export class AttentionDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: AttentionRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: AttentionUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): AttentionUnit {
    const repo = this.repository;
    return {
      limits: (...a) => repo.limits(tx, ...a),
      items: (...a) => repo.items(tx, ...a),
      agents: (...a) => repo.agents(tx, ...a),
    };
  }
}
