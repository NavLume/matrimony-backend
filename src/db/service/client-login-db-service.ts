import type { WorkflowEvent } from '../../bo/event.js';
import type { Account } from '../../bo/identity.js';
import type { ConsentRecord } from '../../bo/registration.js';
import type { Database, Transaction } from '../config/database.js';
import type {
  ClientLoginRepository,
  LinkedLogin,
  LoginProfile,
  OpenLogin,
} from '../raw/repository/client-login-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { RegistrationRepository } from '../raw/repository/registration-repository.js';

/** What giving a client a login may do, bound to one open transaction. */
export interface ClientLoginUnit {
  profile(agencyId: string, profileId: string, lock: boolean): Promise<LoginProfile | null>;
  open(agencyId: string, profileId: string): Promise<OpenLogin | null>;
  byLink(agencyId: string, tokenHash: string, lock: boolean): Promise<LinkedLogin | null>;
  replaceLink(
    agencyId: string,
    link: {
      profileId: string;
      channel: 'sms' | 'email';
      email: string | null;
      phone: string | null;
      locale: 'bn' | 'en';
      tokenHash: string;
      days: number;
      createdBy: string;
    },
  ): Promise<string>;
  revokeOpen(agencyId: string, profileId: string): Promise<boolean>;
  createAccount(
    agencyId: string,
    account: {
      id: string;
      displayName: string;
      channel: 'sms' | 'email';
      email: string | null;
      phone: string | null;
      locale: 'bn' | 'en';
    },
  ): Promise<Account | null>;
  createCredential(agencyId: string, accountId: string, hash: string): Promise<void>;
  recordConsents(
    agencyId: string,
    accountId: string,
    consents: readonly ConsentRecord[],
  ): Promise<void>;
  attachOwner(agencyId: string, profileId: string, accountId: string): Promise<boolean>;
  markAccepted(agencyId: string, linkId: string, accountId: string): Promise<boolean>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class ClientLoginDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: ClientLoginRepository,
    private readonly registrations: Pick<
      RegistrationRepository,
      'createCredential' | 'recordConsents'
    >,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: ClientLoginUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ClientLoginUnit {
    const repo = this.repository;
    return {
      profile: (agencyId, profileId, lock) => repo.profile(tx, agencyId, profileId, lock),
      open: (agencyId, profileId) => repo.open(tx, agencyId, profileId),
      byLink: (agencyId, tokenHash, lock) => repo.byLink(tx, agencyId, tokenHash, lock),
      replaceLink: (agencyId, link) => repo.replaceLink(tx, agencyId, link),
      revokeOpen: (agencyId, profileId) => repo.revokeOpen(tx, agencyId, profileId),
      createAccount: (agencyId, account) => repo.createAccount(tx, agencyId, account),
      createCredential: (agencyId, accountId, hash) =>
        this.registrations.createCredential(tx, agencyId, accountId, hash),
      recordConsents: (agencyId, accountId, consents) =>
        this.registrations.recordConsents(tx, agencyId, accountId, consents),
      attachOwner: (agencyId, profileId, accountId) =>
        repo.attachOwner(tx, agencyId, profileId, accountId),
      markAccepted: (agencyId, linkId, accountId) =>
        repo.markAccepted(tx, agencyId, linkId, accountId),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
