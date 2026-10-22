import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { FlagRepository } from '../raw/repository/flag-repository.js';

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/** Reading flags and recording what staff decided, bound to one open transaction, so a decision and its event are kept together. */
export interface FlagUnit extends Bind<FlagRepository> {
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class FlagDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: FlagRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: FlagUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) =>
      work({
        list: (...a) => this.repository.list(tx, ...a),
        profile: (...a) => this.repository.profile(tx, ...a),
        review: (...a) => this.repository.review(tx, ...a),
        appendEvent: (event) => this.events.append(tx, event),
      }),
    );
  }
}
