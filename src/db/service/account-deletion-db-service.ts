import type { Database } from '../config/database.js';
import type { AccountDeletionRepository } from '../raw/repository/account-deletion-repository.js';

export class AccountDeletionDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: AccountDeletionRepository,
  ) {}
  account(agencyId: string, accountId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.account(tx, agencyId, accountId));
  }
  request(agencyId: string, accountId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.request(tx, agencyId, accountId));
  }
  cancel(agencyId: string, accountId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.cancel(tx, agencyId, accountId));
  }
  scheduleClient(agencyId: string, profileId: string, actorId: string, reason: string) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.scheduleClient(tx, agencyId, profileId, actorId, reason),
    );
  }
  cancelClient(agencyId: string, profileId: string) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.cancelClient(tx, agencyId, profileId),
    );
  }
  eraseDueClients(agencyId: string, before: Date, limit: number) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.eraseDueClients(tx, agencyId, before, limit),
    );
  }
  eraseDue(agencyId: string, before: Date, limit: number) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.eraseDue(tx, agencyId, before, limit),
    );
  }
}
