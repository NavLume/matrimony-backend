import { canManage } from '../bo/access.js';
import type { Journey } from '../bo/journey.js';
import type { JourneyProfile } from '../db/raw/repository/journey-repository.js';
import type { JourneyDbService, JourneyUnit } from '../db/service/journey-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/** Whose journey: the signed-in member's own, or a client's, for the staff who look after them. */
export type JourneyTarget = { kind: 'own' } | { kind: 'client'; profileId: string };

/**
 * A client's journey (see bo/journey.ts). A member reads their own; staff read the clients they look after (an
 * admin: any), and anyone else is told the client does not exist. Staff see names; a member sees another person
 * by member code until that person accepted a proposal.
 */
export class JourneyService {
  constructor(private readonly db: Pick<JourneyDbService, 'inTransaction'>) {}

  async get(actor: ProfileActor, target: JourneyTarget): Promise<Journey> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target);
      return unit.journey(actor.agencyId, profile, target.kind === 'client');
    });
  }

  private async profileOf(
    unit: JourneyUnit,
    actor: ProfileActor,
    target: JourneyTarget,
  ): Promise<JourneyProfile> {
    if (target.kind === 'own') {
      if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return own;
    }
    if (actor.role === 'member' || actor.role === 'guardian')
      throw new AppError(403, 'ROLE_FORBIDDEN');
    const profile = await unit.profileById(actor.agencyId, target.profileId);
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }
}
