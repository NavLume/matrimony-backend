import { canManage } from '../bo/access.js';
import type { DeclinePatterns } from '../bo/decline.js';
import type { DeclineDbService } from '../db/service/decline-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/**
 * What a client said no to (see bo/decline.ts): an admin or the client's own agent reads one client's patterns, to
 * tighten the candidates released to them; an admin reads the whole agency's. The other family never sees reasons.
 */
export class DeclineService {
  constructor(private readonly db: Pick<DeclineDbService, 'inTransaction'>) {}

  async forClient(actor: ProfileActor, profileId: string): Promise<DeclinePatterns> {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.clientOf(actor.agencyId, profileId);
      if (!client || !canManage({ accountId: actor.accountId, role: actor.role }, client))
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      return unit.patterns(actor.agencyId, profileId);
    });
  }

  async forAgency(actor: ProfileActor): Promise<DeclinePatterns> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, (unit) => unit.patterns(actor.agencyId, null));
  }
}
