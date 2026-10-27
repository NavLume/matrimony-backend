import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { ShowcaseRepository } from '../raw/repository/showcase-repository.js';
import type { SiteContentRepository } from '../raw/repository/site-content-repository.js';

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/** Everything the showcase may do, bound to one open transaction. */
export interface ShowcaseUnit extends Bind<ShowcaseRepository> {
  /** The agency's public config (locked), where the showcase's on/off switch and size live. */
  config(agencyId: string): Promise<Record<string, unknown>>;
  saveConfig(agencyId: string, config: Record<string, unknown>): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class ShowcaseDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: ShowcaseRepository,
    private readonly siteContent: SiteContentRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: ShowcaseUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ShowcaseUnit {
    const repo = this.repository;
    const bound = {} as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(repo))) {
      if (name === 'constructor') continue;
      const method = (repo as unknown as Record<string, unknown>)[name];
      if (typeof method === 'function')
        bound[name] = (...args: unknown[]) =>
          (method as (...a: unknown[]) => unknown).call(repo, tx, ...args);
    }
    bound.config = (agencyId: string) => this.siteContent.config(tx, agencyId);
    bound.saveConfig = (agencyId: string, config: Record<string, unknown>) =>
      this.siteContent.saveConfig(tx, agencyId, config);
    bound.appendEvent = (event: WorkflowEvent) => this.events.append(tx, event);
    return bound as unknown as ShowcaseUnit;
  }
}
