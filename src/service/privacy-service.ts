import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { ConsentEntry, DataExport, ErasureState } from '../bo/privacy.js';
import type { PrivacyDbService, PrivacyUnit } from '../db/service/privacy-db-service.js';
import { AppError } from '../exception/app-error.js';
import {
  CLIENT_ERASURE_GRACE_DAYS,
  type AccountDeletionProcess,
} from '../process/account-deletion-process.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<WorkflowEvent['type'], 'account.data_exported' | 'client.data_exported'>;

/**
 * The consent log and the data copy of a person, and erasing a client who has no login (see bo/privacy.ts).
 * A member reads only their own. Staff can do it for a client with no login, because that client has no way to
 * ask: an admin or the client's own agent for the log and the copy, an admin alone for erasing. Erasing is
 * scheduled with a reason: the profile is hidden at once and erased after 7 days unless an admin cancels.
 */
export class PrivacyService {
  constructor(
    private readonly db: Pick<PrivacyDbService, 'inTransaction'>,
    private readonly erasures: Pick<AccountDeletionProcess, 'scheduleClient' | 'cancelClient'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  /** What the signed-in member agreed to. */
  async myConsents(actor: ProfileActor): Promise<ConsentEntry[]> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profileId = await unit.profileOf(actor.agencyId, actor.accountId);
      return unit.consents(actor.agencyId, actor.accountId, profileId);
    });
  }

  /** A copy of the signed-in member's data. */
  async myExport(actor: ProfileActor, correlationId: string): Promise<DataExport> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profileId = await unit.profileOf(actor.agencyId, actor.accountId);
      if (!profileId) throw new AppError(404, 'PROFILE_NOT_FOUND');
      const subject = await unit.subject(actor.agencyId, profileId);
      if (!subject) throw new AppError(404, 'PROFILE_NOT_FOUND');
      const data = await unit.collect(actor.agencyId, profileId, actor.accountId);
      const consents = await unit.consents(actor.agencyId, actor.accountId, profileId);
      await unit.appendEvent(
        this.event('account.data_exported', actor, actor.accountId, correlationId),
      );
      return this.assemble(subject, 'member', data, consents);
    });
  }

  /** The consent log of a client who has no login. */
  async clientConsents(actor: ProfileActor, profileId: string): Promise<ConsentEntry[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.requireClient(unit, actor, profileId);
      return unit.consents(actor.agencyId, null, profileId);
    });
  }

  /** A copy of a client's data, for staff to hand to a client who has no login. */
  async clientExport(
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ): Promise<DataExport> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const subject = await this.requireClient(unit, actor, profileId);
      const data = await unit.collect(actor.agencyId, profileId, null);
      const consents = await unit.consents(actor.agencyId, null, profileId);
      await unit.appendEvent(this.event('client.data_exported', actor, profileId, correlationId));
      return this.assemble(subject, 'client_without_login', data, consents);
    });
  }

  /** Where the erasure of a client with no login stands. Staff who look after the client read it. */
  async erasureState(actor: ProfileActor, profileId: string): Promise<ErasureState> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const subject = await unit.subject(actor.agencyId, profileId);
      if (
        !subject ||
        !canManage(
          { accountId: actor.accountId, role: actor.role },
          { assignedAgentId: subject.assignedAgentId },
        )
      )
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      if (!subject.assisted) throw new AppError(409, 'CLIENT_HAS_LOGIN');
      return unit.erasure(actor.agencyId, profileId, CLIENT_ERASURE_GRACE_DAYS);
    });
  }

  /**
   * Asks for the erasure of a client who has no login. Admins only, with the client's member code typed as a
   * confirmation and a reason. The profile is hidden now; it is erased after 7 days unless cancelled. 404 for an
   * unknown client, 409 CLIENT_HAS_LOGIN for one who can ask themselves, 400 CODE_MISMATCH for a wrong code,
   * 409 ERASURE_NOT_POSSIBLE when it is already scheduled or done.
   */
  async scheduleErasure(
    actor: ProfileActor,
    profileId: string,
    memberCode: string,
    reason: string,
    correlationId: string,
  ): Promise<{ erasesOn: string }> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    const subject = await this.db.inTransaction(actor.agencyId, (unit) =>
      unit.subject(actor.agencyId, profileId),
    );
    if (!subject) throw new AppError(404, 'PROFILE_NOT_FOUND');
    if (!subject.assisted) throw new AppError(409, 'CLIENT_HAS_LOGIN');
    if (subject.memberCode.toLowerCase() !== memberCode.toLowerCase())
      throw new AppError(400, 'CODE_MISMATCH');
    const erasesOn = await this.erasures.scheduleClient(actor, profileId, reason, correlationId);
    if (!erasesOn) throw new AppError(409, 'ERASURE_NOT_POSSIBLE');
    return { erasesOn: erasesOn.toISOString() };
  }

  /** Stops a scheduled erasure and brings the client back as they were. Admins only. */
  async cancelErasure(actor: ProfileActor, profileId: string, correlationId: string) {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    const done = await this.erasures.cancelClient(actor, profileId, correlationId);
    if (!done) throw new AppError(409, 'NO_ERASURE_SCHEDULED');
  }

  private async requireClient(unit: PrivacyUnit, actor: ProfileActor, profileId: string) {
    const subject = await unit.subject(actor.agencyId, profileId);
    if (
      !subject ||
      !canManage(
        { accountId: actor.accountId, role: actor.role },
        { assignedAgentId: subject.assignedAgentId },
      )
    )
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    if (!subject.assisted) throw new AppError(409, 'CLIENT_HAS_LOGIN');
    return subject;
  }

  private assemble(
    subject: { memberCode: string; name: string },
    kind: DataExport['subject']['kind'],
    data: Omit<DataExport, 'generatedAt' | 'subject' | 'notes' | 'consents'>,
    consents: ConsentEntry[],
  ): DataExport {
    return {
      generatedAt: this.now().toISOString(),
      subject: { memberCode: subject.memberCode, name: subject.name, kind },
      notes: [
        'This is a copy of the personal data the agency holds about you.',
        'Photos, your CV and your identity document are not copied here, because you have those files.',
        'Other people appear by member code only.',
      ],
      ...data,
      consents,
    };
  }

  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
  private requireStaff(actor: ProfileActor) {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
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
