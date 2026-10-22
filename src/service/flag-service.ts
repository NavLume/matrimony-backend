import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { FlagOutcome, FlagRow, FlagState, Signal } from '../bo/flags.js';
import type { FlagDbService } from '../db/service/flag-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/**
 * Fraud signals for staff (see bo/flags.ts): an admin sees every flag, an agent only those on the clients they look
 * after. A flag only informs: nothing here pauses or blocks a profile, and no member-facing call returns one.
 */
export class FlagService {
  constructor(
    private readonly db: Pick<FlagDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async list(actor: ProfileActor, state: FlagState): Promise<FlagRow[]> {
    this.requireStaff(actor);
    const flags = await this.db.inTransaction(actor.agencyId, (unit) =>
      unit.list(actor.agencyId, {
        profileId: null,
        agentId: actor.role === 'agent' ? actor.accountId : null,
      }),
    );
    return flags.filter((flag) => (flag.status === 'open') === (state === 'open'));
  }

  /** Every flag on one client, open or decided. 404 for a client the staff member does not look after. */
  async forClient(actor: ProfileActor, profileId: string): Promise<FlagRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.requireClient(unit, actor, profileId);
      return unit.list(actor.agencyId, { profileId, agentId: null });
    });
  }

  /** Marks a flag checked and fine, or confirmed as a problem. 404 FLAG_NOT_FOUND when that flag does not apply now. */
  async review(
    actor: ProfileActor,
    profileId: string,
    signal: Signal,
    outcome: FlagOutcome,
    correlationId: string,
  ): Promise<FlagRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.requireClient(unit, actor, profileId);
      const flags = await unit.list(actor.agencyId, { profileId, agentId: null });
      if (!flags.some((flag) => flag.signal === signal)) throw new AppError(404, 'FLAG_NOT_FOUND');
      await unit.review(actor.agencyId, profileId, signal, outcome, actor.accountId);
      await unit.appendEvent({
        id: this.newId(),
        agencyId: actor.agencyId,
        actorId: actor.accountId,
        subjectId: profileId,
        type: 'flag.reviewed',
        version: 1,
        occurredAt: this.now().toISOString(),
        correlationId,
      } satisfies WorkflowEvent);
      return unit.list(actor.agencyId, { profileId, agentId: null });
    });
  }

  private async requireClient(
    unit: Parameters<Parameters<FlagDbService['inTransaction']>[1]>[0],
    actor: ProfileActor,
    profileId: string,
  ) {
    const profile = await unit.profile(actor.agencyId, profileId);
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
  }

  private requireStaff(actor: ProfileActor) {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}
