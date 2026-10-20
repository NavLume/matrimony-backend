import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { CoupleMatchRepository } from '../raw/repository/couple-match-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/** Everything the matched step may do, bound to one open transaction, so both clients, the match and its event are stored together. */
export interface CoupleMatchUnit extends Bind<CoupleMatchRepository> {
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class CoupleMatchDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: CoupleMatchRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: CoupleMatchUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): CoupleMatchUnit {
    const repo = this.repository;
    const bound = {} as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(repo))) {
      if (name === 'constructor') continue;
      const method = (repo as unknown as Record<string, unknown>)[name];
      if (typeof method === 'function')
        bound[name] = (...args: unknown[]) =>
          (method as (...a: unknown[]) => unknown).call(repo, tx, ...args);
    }
    bound.appendEvent = (event: WorkflowEvent) => this.events.append(tx, event);
    return bound as unknown as CoupleMatchUnit;
  }
}
