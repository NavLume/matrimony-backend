import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { ChatRepository } from '../raw/repository/chat-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/** Everything chat may do, bound to one open transaction, so a message and its notice are stored together. */
export interface ChatUnit extends Bind<ChatRepository> {
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class ChatDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: ChatRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: ChatUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ChatUnit {
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
    return bound as unknown as ChatUnit;
  }
}
