import { funnelOf, type Funnel, type FunnelQuery } from '../bo/funnel.js';
import type { FunnelDbService } from '../db/service/funnel-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/**
 * The full funnel (see bo/funnel.ts). An admin reads the whole agency, or one agent's clients with `agentId`; an
 * agent reads only their own clients, and asking for another agent's is refused.
 */
export class FunnelService {
  constructor(private readonly db: Pick<FunnelDbService, 'people'>) {}

  async report(actor: ProfileActor, query: FunnelQuery): Promise<Funnel> {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
    if (actor.role === 'agent' && query.agentId && query.agentId !== actor.accountId)
      throw new AppError(403, 'ROLE_FORBIDDEN');
    const agentId = actor.role === 'agent' ? actor.accountId : (query.agentId ?? null);
    const people = await this.db.people(actor.agencyId, {
      from: query.from ?? null,
      to: query.to ?? null,
      agentId,
    });
    return funnelOf(people);
  }
}
