import type { Database, Transaction } from '../config/database.js';
import type { DeclineRepository } from '../raw/repository/decline-repository.js';

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
export type DeclineUnit = { [K in keyof DeclineRepository]: Bound<DeclineRepository[K]> };

/** Reading what clients said no to, bound to one open transaction. */
export class DeclineDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: DeclineRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: DeclineUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) =>
      work({
        clientOf: (...a) => this.repository.clientOf(tx, ...a),
        patterns: (...a) => this.repository.patterns(tx, ...a),
      }),
    );
  }
}
