import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { SettingsRepository } from '../raw/repository/settings-repository.js';

/** Reading and changing the agency's settings, bound to one open transaction, so a change and its event are kept together. */
export interface SettingsUnit {
  get: SettingsRepositoryBound['get'];
  save: SettingsRepositoryBound['save'];
  appendEvent(event: WorkflowEvent): Promise<void>;
}

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type SettingsRepositoryBound = { [K in keyof SettingsRepository]: Bound<SettingsRepository[K]> };

export class SettingsDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: SettingsRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: SettingsUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): SettingsUnit {
    const repo = this.repository;
    return {
      get: (...a) => repo.get(tx, ...a),
      save: (...a) => repo.save(tx, ...a),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
