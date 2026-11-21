import { randomBytes, randomUUID } from 'node:crypto';
import {
  slugify,
  type CampaignLink,
  type CampaignLinkInput,
  type LinkKind,
} from '../bo/campaign-link.js';
import type { WorkflowEvent } from '../bo/event.js';
import type {
  CampaignLinkDbService,
  CampaignLinkUnit,
} from '../db/service/campaign-link-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/** The start of a campaign name made from the kind, for a name with no Latin letters (for example in Bangla). */
const PREFIX: Record<LinkKind, string> = {
  facebook_ad: 'fb-ad',
  facebook_post: 'fb-post',
  whatsapp: 'whatsapp',
  old_site: 'old-site',
  event_qr: 'event',
  office_qr: 'office',
  other: 'link',
};
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * The links page (see bo/campaign-link.ts). Agents and admins read every link of the agency and make new ones; an
 * admin or the person who made a link puts it away or brings it back. Members cannot reach any of it.
 */
export class CampaignLinkService {
  constructor(
    private readonly db: Pick<CampaignLinkDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly random: (size: number) => Uint8Array = (size) => randomBytes(size),
  ) {}

  async list(actor: ProfileActor, archived: boolean): Promise<CampaignLink[]> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, (unit) => unit.list(actor.agencyId, archived));
  }

  /**
   * Makes a link. Its campaign name comes from the name (a taken one gets -2, -3...), or from the kind and a short
   * random part when the name has no Latin letters.
   */
  async create(
    actor: ProfileActor,
    input: CampaignLinkInput,
    correlationId: string,
  ): Promise<CampaignLink> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const base = slugify(input.name);
      const candidates = base ? [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}-${n}`)] : [];
      for (let i = 0; i < 5; i++) candidates.push(`${base || PREFIX[input.kind]}-${this.code()}`);
      for (const slug of candidates) {
        const id = await unit.insert(actor.agencyId, {
          ...input,
          slug,
          createdBy: actor.accountId,
        });
        if (id) {
          await unit.appendEvent(this.event(actor, id, 'campaign_link.created', correlationId));
          return (await unit.one(actor.agencyId, id))!;
        }
      }
      throw new AppError(503, 'TRY_AGAIN');
    });
  }

  /** Puts a link away (or back). Only an admin or the person who made it. The link keeps working either way. */
  async archive(
    actor: ProfileActor,
    id: string,
    archived: boolean,
    correlationId: string,
  ): Promise<CampaignLink> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const link = await this.find(unit, actor, id);
      if (actor.role !== 'admin' && link.createdBy.id !== actor.accountId)
        throw new AppError(403, 'ROLE_FORBIDDEN');
      if ((link.archivedAt !== null) !== archived) {
        await unit.setArchived(actor.agencyId, id, archived);
        await unit.appendEvent(
          this.event(
            actor,
            id,
            archived ? 'campaign_link.archived' : 'campaign_link.restored',
            correlationId,
          ),
        );
      }
      return (await unit.one(actor.agencyId, id))!;
    });
  }

  private async find(unit: CampaignLinkUnit, actor: ProfileActor, id: string) {
    const link = await unit.one(actor.agencyId, id);
    if (!link) throw new AppError(404, 'NOT_FOUND');
    return link;
  }

  private staffOnly(actor: ProfileActor) {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  /** Four random characters with no look-alikes. */
  private code(): string {
    return Array.from(this.random(4), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
  }

  private event(
    actor: ProfileActor,
    subjectId: string,
    type: WorkflowEvent['type'],
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
