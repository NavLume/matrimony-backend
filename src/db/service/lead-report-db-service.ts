import type { Database, Transaction } from '../config/database.js';
import type { LeadReportRepository } from '../raw/repository/lead-report-repository.js';

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/** The lead reports and the visit counter, bound to one open transaction. */
export type LeadReportUnit = Bind<LeadReportRepository>;

export class LeadReportDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: LeadReportRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: LeadReportUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): LeadReportUnit {
    const repo = this.repository;
    const bound = {} as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(repo))) {
      if (name === 'constructor') continue;
      const method = (repo as unknown as Record<string, unknown>)[name];
      if (typeof method === 'function')
        bound[name] = (...args: unknown[]) =>
          (method as (...a: unknown[]) => unknown).call(repo, tx, ...args);
    }
    return bound as unknown as LeadReportUnit;
  }
}
