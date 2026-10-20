import type { WorkflowEvent } from '../../bo/event.js';
import type { Database } from '../config/database.js';
import type { AgreementRepository } from '../raw/repository/agreement-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/** The unit of work for agreeing to the agency's texts. */
export class AgreementDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: AgreementRepository,
    private readonly events: EventRepository,
  ) {}

  accepted(agencyId: string, accountId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.accepted(tx, agencyId, accountId));
  }

  /** Records the agreements and the event together. */
  accept(
    agencyId: string,
    accountId: string,
    versions: { purpose: 'terms' | 'privacy'; version: string }[],
    event: WorkflowEvent,
  ) {
    return this.db.transaction(agencyId, async (tx) => {
      for (const v of versions)
        await this.repository.record(tx, agencyId, accountId, v.purpose, v.version);
      await this.events.append(tx, event);
    });
  }
}
