import type { Database, Transaction } from '../config/database.js';
import type { IntroductionRepository } from '../raw/repository/introduction-repository.js';

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
export type IntroductionUnit = {
  [K in keyof IntroductionRepository]: Bound<IntroductionRepository[K]>;
};

/** Reading the introduction ledger, bound to one open transaction. */
export class IntroductionDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: IntroductionRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: IntroductionUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) =>
      work({
        parties: (...a) => this.repository.parties(tx, ...a),
        history: (...a) => this.repository.history(tx, ...a),
        byAgent: (...a) => this.repository.byAgent(tx, ...a),
      }),
    );
  }
}
