import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '../bo/event.js';
import type { MessageChannel, MessagePreference, MessageUsage } from '../bo/messaging.js';
import { maskPhone } from '../bo/phone.js';
import type { MessagingDbService } from '../db/service/messaging-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/**
 * A member's choice of texts outside the app (see bo/messaging.ts), and for an admin what was sent. Turning a
 * channel on needs a channel the agency can send on and a verified phone number on the account; it is the member's
 * agreement, recorded with its date, and what was already waiting is not sent.
 */
export class MessagingService {
  constructor(
    private readonly db: Pick<MessagingDbService, 'inTransaction'>,
    private readonly available: () => { sms: boolean },
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async get(actor: ProfileActor): Promise<MessagePreference> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, (unit) => this.read(unit, actor));
  }

  async set(
    actor: ProfileActor,
    channel: MessageChannel,
    correlationId: string,
  ): Promise<MessagePreference> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      if (channel !== 'none') {
        // Nobody can agree to something the agency has switched off, or cannot send.
        if (!(await unit.messagingSettings(actor.agencyId)).enabled || !this.available()[channel])
          throw new AppError(409, 'CHANNEL_NOT_AVAILABLE');
        const contact = await unit.contact(actor.agencyId, actor.accountId);
        if (!contact?.phone || !contact.verified) throw new AppError(409, 'PHONE_REQUIRED');
        // What is waiting now was there before the person agreed, and is not sent.
        await unit.markAllHandled(actor.agencyId, actor.accountId);
      }
      await unit.setPreference(actor.agencyId, actor.accountId, channel);
      await unit.appendEvent({
        id: this.newId(),
        agencyId: actor.agencyId,
        actorId: actor.accountId,
        subjectId: actor.accountId,
        type: 'account.messaging_changed',
        version: 1,
        occurredAt: this.now().toISOString(),
        correlationId,
      } satisfies WorkflowEvent);
      return this.read(unit, actor);
    });
  }

  async usage(actor: ProfileActor): Promise<MessageUsage> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => ({
      ...(await unit.usage(actor.agencyId)),
      ...(await unit.messagingSettings(actor.agencyId)),
    }));
  }

  private async read(
    unit: Parameters<Parameters<MessagingDbService['inTransaction']>[1]>[0],
    actor: ProfileActor,
  ): Promise<MessagePreference> {
    const contact = await unit.contact(actor.agencyId, actor.accountId);
    return {
      channel: await unit.preference(actor.agencyId, actor.accountId),
      enabled: (await unit.messagingSettings(actor.agencyId)).enabled,
      available: this.available(),
      phone: contact?.phone ? maskPhone(contact.phone) : null,
      phoneVerified: contact?.verified === true,
    };
  }

  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}
