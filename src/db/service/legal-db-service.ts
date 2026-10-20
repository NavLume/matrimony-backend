import type { WorkflowEvent } from '../../bo/event.js';
import type { LegalInput, LegalKind } from '../../bo/legal.js';
import type { Database } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { LegalRepository } from '../raw/repository/legal-repository.js';

/** The unit of work for the agency's legal documents. */
export class LegalDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: LegalRepository,
    private readonly events: EventRepository,
  ) {}

  current(agencyId: string, kind: LegalKind) {
    return this.db.transaction(agencyId, (tx) => this.repository.current(tx, agencyId, kind));
  }

  /** Adds a version and records the event together. */
  save(
    agencyId: string,
    kind: LegalKind,
    input: LegalInput,
    accountId: string,
    event: WorkflowEvent,
  ) {
    return this.db.transaction(agencyId, async (tx) => {
      const added = await this.repository.addVersion(tx, agencyId, kind, input, accountId);
      await this.events.append(tx, event);
      return added;
    });
  }
}
