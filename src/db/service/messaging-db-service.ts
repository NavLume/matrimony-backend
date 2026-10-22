import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { MessagingRepository } from '../raw/repository/messaging-repository.js';
import type { SettingsRepository } from '../raw/repository/settings-repository.js';

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/** Everything outside messages need, bound to one open transaction. */
export interface MessagingUnit extends Bind<MessagingRepository> {
  /** Whether the agency sends texts at all, and its daily limit (0 sends none). */
  messagingSettings(
    agencyId: string,
  ): Promise<{ enabled: boolean; dailyLimit: number; perMemberDaily: number }>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class MessagingDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: MessagingRepository,
    private readonly settings: SettingsRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: MessagingUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): MessagingUnit {
    const repo = this.repository;
    const bound = {} as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(repo))) {
      if (name === 'constructor') continue;
      const method = (repo as unknown as Record<string, unknown>)[name];
      if (typeof method === 'function')
        bound[name] = (...args: unknown[]) =>
          (method as (...a: unknown[]) => unknown).call(repo, tx, ...args);
    }
    bound.messagingSettings = async (agencyId: string) =>
      (await this.settings.get(tx, agencyId)).messaging;
    bound.appendEvent = (event: WorkflowEvent) => this.events.append(tx, event);
    return bound as unknown as MessagingUnit;
  }
}
