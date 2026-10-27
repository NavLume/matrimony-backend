import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import {
  ageBand,
  BROWSE_PAGE_SIZE,
  parseShowcaseSettings,
  type BrowseFilter,
  type Lead,
  type ShowcaseCandidate,
  type ShowcaseCard,
  type ShowcaseSettings,
} from '../bo/showcase.js';
import type { ShowcaseDbService, ShowcaseUnit } from '../db/service/showcase-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type Row = Record<string, unknown>;

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, max) : [];
const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** Whose "show on the website" switch: the signed-in member's own profile, or a client's, for staff. */
export type SwitchTarget = { kind: 'own' } | { kind: 'client'; profileId: string };

/**
 * The rules of "Meet our members" (see bo/showcase.ts).
 *
 * - Only the admin turns it on, chooses who is shown and works the leads. It is off until switched on.
 * - Only a published profile with a photo can be added, and one that was switched off cannot.
 * - A profile is switched off or on by its member, by the staff who look after it, or by an admin.
 * - What the public sees is built here from stored facts: an age band, a profession, a district, and a few words
 *   from the person's own partner preferences. Nothing else leaves.
 */
export class ShowcaseService {
  constructor(
    private readonly db: Pick<ShowcaseDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  // ---- the public site -------------------------------------------------------------------------

  async settingsOf(agencyId: string): Promise<ShowcaseSettings> {
    return this.db.inTransaction(agencyId, async (unit) =>
      parseShowcaseSettings(await unit.publicConfig(agencyId)),
    );
  }

  /** The cards the public site shows: nothing at all while the agency has not switched it on. */
  async publicCards(agencyId: string): Promise<ShowcaseCard[]> {
    return this.db.inTransaction(agencyId, async (unit) => {
      const settings = parseShowcaseSettings(await unit.publicConfig(agencyId));
      if (!settings.enabled) return [];
      const rows = (await unit.cards(agencyId, settings.limit)) as Row[];
      const today = this.now();
      return rows.map((row) => this.card(row, today));
    });
  }

  /** One card from a stored row: only generic facts leave. */
  private card(row: Row, today: Date): ShowcaseCard {
    return {
      ref: row.ref as string,
      ageBand: ageBand((row.dob as string | null) ?? null, today),
      professionCode: (row.profession_code as string | null) ?? null,
      districtCode: (row.current_district_code as string | null) ?? null,
      religionCode: (row.religion_code as string | null) ?? null,
      countryCode: (row.country_code as string | null) ?? 'bangladesh',
      wants: {
        ageMin: number(row.age_min),
        ageMax: number(row.age_max),
        educationMinCode: (row.education_min_code as string | null) ?? null,
        professionCodes: strings(row.profession_codes, 2),
        districtCodes: strings(row.district_codes, 1),
        practiceCodes: strings(row.religious_practice_codes, 1),
      },
    };
  }

  /** The browse page: every showable card that matches the filters, a page at a time. Nothing while the showcase is off. */
  async browse(agencyId: string, filter: BrowseFilter, page: number) {
    return this.db.inTransaction(agencyId, async (unit) => {
      const settings = parseShowcaseSettings(await unit.publicConfig(agencyId));
      if (!settings.enabled)
        return { cards: [] as ShowcaseCard[], total: 0, page, pageSize: BROWSE_PAGE_SIZE };
      const rows = (await unit.browse(
        agencyId,
        filter,
        BROWSE_PAGE_SIZE,
        (page - 1) * BROWSE_PAGE_SIZE,
      )) as Row[];
      const today = this.now();
      return {
        cards: rows.map((row) => this.card(row, today)),
        total: rows.length > 0 ? Number(rows[0]!.total) : 0,
        page,
        pageSize: BROWSE_PAGE_SIZE,
      };
    });
  }

  /**
   * A member tells their agent which card they liked. It lands as a reminder on the agent's agenda, and the agent reviews it
   * and, if it is a good match, releases the profile through the usual candidate release. A member with no agent yet is told so.
   */
  async requestIntroduction(
    actor: ProfileActor,
    ref: string,
    note: string | undefined,
    correlationId: string,
  ): Promise<{ created: boolean }> {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await unit.switchTarget(actor.agencyId, { own: actor.accountId });
      if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
      if (!own.assignedAgentId) throw new AppError(409, 'NO_AGENT');
      const code = await unit.codeOfRef(actor.agencyId, ref);
      if (!code) throw new AppError(404, 'NOT_FOUND');
      const id = this.newId();
      const text = `Website: asked about ${code}${note ? `: ${note}` : ''}`.slice(0, 200);
      const created = await unit.addIntroductionRequest(actor.agencyId, {
        id,
        profileId: own.id,
        assignedTo: own.assignedAgentId,
        createdBy: actor.accountId,
        text,
      });
      if (created)
        await unit.appendEvent({ ...this.event(actor, id, correlationId), type: 'followup.added' });
      return { created };
    });
  }

  /** The stored photo of a showable card, or null (also when the showcase is off). */
  async photoKey(agencyId: string, ref: string): Promise<string | null> {
    return this.db.inTransaction(agencyId, async (unit) => {
      if (!parseShowcaseSettings(await unit.publicConfig(agencyId)).enabled) return null;
      return unit.photoKey(agencyId, ref);
    });
  }

  /** Whether a visitor may leave a lead now (the showcase is on). */
  async acceptsLeads(agencyId: string): Promise<boolean> {
    return (await this.settingsOf(agencyId)).enabled;
  }

  /** Records what a visitor left, after their number was proved. A card that is gone is not an error: they still asked. */
  async recordLead(agencyId: string, lead: { name: string; phone: string; ref?: string }) {
    await this.db.inTransaction(agencyId, async (unit) => {
      const profileId = lead.ref ? await unit.profileOfRef(agencyId, lead.ref) : null;
      await unit.insertLead(agencyId, { name: lead.name, phone: lead.phone, profileId });
    });
  }

  // ---- the admin -------------------------------------------------------------------------------

  async overview(actor: ProfileActor) {
    this.adminOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => ({
      settings: parseShowcaseSettings(await unit.publicConfig(actor.agencyId)),
      entries: await unit.entries(actor.agencyId),
      eligible: await unit.eligible(actor.agencyId, 200),
      newLeads: await unit.newLeadCount(actor.agencyId),
    }));
  }

  async setSettings(actor: ProfileActor, settings: ShowcaseSettings, correlationId: string) {
    this.adminOnly(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const config = await unit.config(actor.agencyId);
      await unit.saveConfig(actor.agencyId, { ...config, showcase: settings });
      await unit.appendEvent(this.event(actor, null, correlationId));
    });
  }

  async addEntry(actor: ProfileActor, profileId: string, correlationId: string) {
    this.adminOnly(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await unit.profileForShowcase(actor.agencyId, profileId);
      if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
      if (profile.status !== 'active') throw new AppError(409, 'PROFILE_NOT_PUBLISHED');
      if (profile.hidden) throw new AppError(409, 'WEBSITE_HIDDEN');
      if (!profile.hasPhoto) throw new AppError(409, 'PHOTO_REQUIRED');
      await unit.add(actor.agencyId, profileId, actor.accountId);
      await unit.appendEvent(this.event(actor, profileId, correlationId));
    });
  }

  async removeEntry(actor: ProfileActor, profileId: string, correlationId: string) {
    this.adminOnly(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      if (!(await unit.remove(actor.agencyId, profileId))) throw new AppError(404, 'NOT_FOUND');
      await unit.appendEvent(this.event(actor, profileId, correlationId));
    });
  }

  async leads(actor: ProfileActor, status: string | null): Promise<Lead[]> {
    this.adminOnly(actor);
    return this.db.inTransaction(actor.agencyId, (unit) => unit.leads(actor.agencyId, status, 200));
  }

  async updateLead(
    actor: ProfileActor,
    id: string,
    change: { status: string; note?: string },
    correlationId: string,
  ) {
    this.adminOnly(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const found = await unit.updateLead(actor.agencyId, id, {
        status: change.status,
        note: change.note ?? null,
        by: actor.accountId,
      });
      if (!found) throw new AppError(404, 'NOT_FOUND');
      await unit.appendEvent(this.event(actor, null, correlationId));
    });
  }

  // ---- the "show on the website" switch ---------------------------------------------------------

  /** Whether a profile is switched off, for the member or the staff who look after it. */
  async hidden(actor: ProfileActor, target: SwitchTarget): Promise<boolean> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.find(unit, actor, target);
      return profile.hidden;
    });
  }

  /** Switches a profile off the public site, or lets it be shown again. A hidden profile also leaves the showcase. */
  async setHidden(
    actor: ProfileActor,
    hidden: boolean,
    target: SwitchTarget,
    correlationId: string,
  ) {
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.find(unit, actor, target);
      await unit.setHidden(actor.agencyId, profile.id, hidden);
      if (hidden) await unit.remove(actor.agencyId, profile.id);
      await unit.appendEvent(this.event(actor, profile.id, correlationId));
    });
  }

  private async find(unit: ShowcaseUnit, actor: ProfileActor, target: SwitchTarget) {
    if (target.kind === 'own') {
      if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
      const own = await unit.switchTarget(actor.agencyId, { own: actor.accountId });
      if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return own;
    }
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
    const profile = await unit.switchTarget(actor.agencyId, { profileId: target.profileId });
    // An agent is told a profile that is not theirs does not exist.
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  private adminOnly(actor: ProfileActor) {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private event(
    actor: ProfileActor,
    subjectId: string | null,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: this.newId(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      subjectId,
      type: 'site.content_updated',
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    };
  }
}

export type { ShowcaseCandidate };
