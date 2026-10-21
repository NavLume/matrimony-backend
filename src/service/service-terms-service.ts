import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { ServiceTermsInput, ServiceTermsState } from '../bo/service-terms.js';
import type { TermsProfile } from '../db/raw/repository/service-terms-repository.js';
import type {
  ServiceTermsDbService,
  ServiceTermsUnit,
} from '../db/service/service-terms-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  'service_terms.recorded' | 'service_terms.acknowledged'
>;

/** Whose terms: the signed-in member's own, or a client's, for the staff who look after them. */
export type TermsTarget = { kind: 'own' } | { kind: 'client'; profileId: string };

/**
 * The terms of a client's service (see bo/service-terms.ts).
 *
 * - Staff record them for the clients they look after (an admin: any); anyone else gets "not found".
 * - Every save is a new version; the client's confirmation applies to the version they saw, so a new version
 *   asks them again.
 * - The client confirms their own terms in the app. For a client with no login, or one who agreed in the
 *   office, the staff member records that, and the record says it was done that way.
 */
export class ServiceTermsService {
  constructor(
    private readonly db: Pick<ServiceTermsDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async state(actor: ProfileActor, target: TermsTarget): Promise<ServiceTermsState> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target);
      return this.read(unit, actor, profile, target.kind === 'client');
    });
  }

  async record(
    actor: ProfileActor,
    profileId: string,
    input: ServiceTermsInput,
    correlationId: string,
  ): Promise<ServiceTermsState> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      await unit.insert(actor.agencyId, profile.id, input, actor.accountId);
      await unit.appendEvent(
        this.event('service_terms.recorded', actor, profile.id, correlationId),
      );
      return this.read(unit, actor, profile, true);
    });
  }

  async acknowledge(
    actor: ProfileActor,
    target: TermsTarget,
    correlationId: string,
  ): Promise<ServiceTermsState> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target);
      const [newest] = await unit.versions(actor.agencyId, profile.id);
      if (!newest) throw new AppError(404, 'TERMS_NOT_FOUND');
      if (newest.acknowledged) throw new AppError(409, 'TERMS_ALREADY_CONFIRMED');
      const how = target.kind === 'own' ? 'client' : 'office';
      if (!(await unit.acknowledge(actor.agencyId, profile.id, actor.accountId, how)))
        throw new AppError(409, 'TERMS_ALREADY_CONFIRMED');
      await unit.appendEvent(
        this.event('service_terms.acknowledged', actor, profile.id, correlationId),
      );
      return this.read(unit, actor, profile, target.kind === 'client');
    });
  }

  private async read(
    unit: ServiceTermsUnit,
    actor: ProfileActor,
    profile: TermsProfile,
    forStaff: boolean,
  ): Promise<ServiceTermsState> {
    const versions = await unit.versions(actor.agencyId, profile.id);
    return {
      profile: { id: profile.id, memberCode: profile.memberCode, fullName: profile.fullName },
      current: versions[0] ?? null,
      history: forStaff ? versions : [],
    };
  }

  /** The profile the actor may see the terms of, or "not found". */
  private async profileOf(
    unit: ServiceTermsUnit,
    actor: ProfileActor,
    target: TermsTarget,
  ): Promise<TermsProfile> {
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

  private event(
    type: EventType,
    actor: ProfileActor,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: this.newId(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      subjectId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    };
  }
}
