import { randomUUID } from 'node:crypto';
import type { ConcernInput, ConcernRow, MyConcern, RecordConcernInput } from '../bo/concern.js';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { ConcernDbService } from '../db/service/concern-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<WorkflowEvent['type'], 'concern.reported' | 'concern.resolved'>;

/**
 * Private concerns (see bo/concern.ts). A member reports, and reads their own. An admin reads all of them. An agent
 * reads only those about a profile of a client they look after, without who reported them; a concern about the
 * agency's staff or about something else goes to admins alone, because it may be about the agent. Neither the
 * family nor a guardian sees one.
 */
export class ConcernService {
  constructor(
    private readonly db: Pick<ConcernDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async report(
    actor: ProfileActor,
    input: ConcernInput,
    correlationId: string,
  ): Promise<MyConcern[]> {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      if (
        input.about === 'profile' &&
        !(await unit.reportable(actor.agencyId, input.profileId!, actor.accountId))
      )
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      const id = this.newId();
      await unit.insert(actor.agencyId, id, actor.accountId, input);
      await unit.tellStaff(actor.agencyId, id, actor.accountId);
      await unit.appendEvent(this.event('concern.reported', actor, id, correlationId));
      return unit.mine(actor.agencyId, actor.accountId);
    });
  }

  /**
   * Staff record a concern for a client who has no login, after the client phoned, visited or sent word through a
   * relative. An admin may record any concern; the client's own agent only one about another member's profile (a
   * concern about the agency's staff must reach an admin without passing through an agent). Staff who do not look
   * after the client get "not found". The client cannot read the outcome here: staff tell them.
   */
  async recordFor(
    actor: ProfileActor,
    clientId: string,
    input: RecordConcernInput,
    correlationId: string,
  ): Promise<ConcernRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.clientForRecording(actor.agencyId, clientId);
      if (!client || !canManage({ accountId: actor.accountId, role: actor.role }, client))
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      if (!client.assisted) throw new AppError(409, 'CLIENT_HAS_LOGIN');
      if (actor.role === 'agent' && input.about !== 'profile')
        throw new AppError(403, 'CONCERN_ADMIN_ONLY');
      let aboutProfileId: string | null = null;
      if (input.about === 'profile') {
        aboutProfileId = await unit.profileByCode(actor.agencyId, input.memberCode!);
        if (!aboutProfileId || aboutProfileId === client.id)
          throw new AppError(404, 'PROFILE_NOT_FOUND');
      }
      const id = this.newId();
      await unit.insertForClient(actor.agencyId, id, client.id, actor.accountId, input.toldBy, {
        about: input.about,
        aboutProfileId,
        category: input.category,
        message: input.message,
      });
      await unit.tellStaff(actor.agencyId, id, actor.accountId);
      await unit.appendEvent(this.event('concern.reported', actor, id, correlationId));
      return unit.list(actor.agencyId, 'open', this.viewer(actor));
    });
  }

  async mine(actor: ProfileActor): Promise<MyConcern[]> {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, (unit) =>
      unit.mine(actor.agencyId, actor.accountId),
    );
  }

  async list(actor: ProfileActor, status: 'open' | 'resolved'): Promise<ConcernRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, (unit) =>
      unit.list(actor.agencyId, status, this.viewer(actor)),
    );
  }

  async resolve(
    actor: ProfileActor,
    concernId: string,
    note: string,
    correlationId: string,
  ): Promise<ConcernRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const { found, reporter } = await unit.resolve(
        actor.agencyId,
        concernId,
        actor.accountId,
        note,
        this.viewer(actor),
      );
      // Also what an agent gets for a concern that is not theirs to read: it does not exist for them.
      if (!found) throw new AppError(404, 'CONCERN_NOT_FOUND');
      // A client with no login has no inbox: staff tell them the outcome in person or by phone.
      if (reporter) await unit.tellReporter(actor.agencyId, concernId, reporter);
      await unit.appendEvent(this.event('concern.resolved', actor, concernId, correlationId));
      return unit.list(actor.agencyId, 'open', this.viewer(actor));
    });
  }

  private requireStaff(actor: ProfileActor) {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  /** The agent whose view this is, or null for an admin, who sees everything. */
  private viewer(actor: ProfileActor) {
    return actor.role === 'admin' ? null : actor.accountId;
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
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
