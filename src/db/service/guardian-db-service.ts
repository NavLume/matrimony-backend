import type { WorkflowEvent } from '../../bo/event.js';
import type { ConsentRecord } from '../../bo/registration.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { GuardianRepository } from '../raw/repository/guardian-repository.js';
import type { RegistrationRepository } from '../raw/repository/registration-repository.js';

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bind<T> = { [K in keyof T]: Bound<T[K]> };

/**
 * Everything guardians may do, bound to one open transaction, so a change, its inbox lines and its
 * event are stored together.
 */
export interface GuardianUnit extends Bind<GuardianRepository> {
  createCredential(agencyId: string, accountId: string, hash: string): Promise<void>;
  recordConsents(
    agencyId: string,
    accountId: string,
    consents: readonly ConsentRecord[],
  ): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class GuardianDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: GuardianRepository,
    private readonly registrations: Pick<
      RegistrationRepository,
      'createCredential' | 'recordConsents'
    >,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: GuardianUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): GuardianUnit {
    const repo = this.repository;
    const bound = {} as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(repo))) {
      if (name === 'constructor') continue;
      const method = (repo as unknown as Record<string, unknown>)[name];
      if (typeof method === 'function')
        bound[name] = (...args: unknown[]) =>
          (method as (...a: unknown[]) => unknown).call(repo, tx, ...args);
    }
    bound.createCredential = (agencyId: string, accountId: string, hash: string) =>
      this.registrations.createCredential(tx, agencyId, accountId, hash);
    bound.recordConsents = (
      agencyId: string,
      accountId: string,
      consents: readonly ConsentRecord[],
    ) => this.registrations.recordConsents(tx, agencyId, accountId, consents);
    bound.appendEvent = (event: WorkflowEvent) => this.events.append(tx, event);
    return bound as unknown as GuardianUnit;
  }
}
