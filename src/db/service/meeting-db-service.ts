import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { MeetingRepository } from '../raw/repository/meeting-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/** Everything meetings, notes and follow-ups may do, bound to one open transaction, so a change, its inbox lines and its event are stored together. */
export interface MeetingUnit extends Bind<MeetingRepository> {
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class MeetingDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: MeetingRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: MeetingUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): MeetingUnit {
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
    return bound as unknown as MeetingUnit;
  }
}
