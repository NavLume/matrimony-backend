import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '../bo/event.js';
import { parseSettings } from '../bo/agency-settings.js';
import {
  cleanPath,
  referenceFrom,
  referrerHost,
  REPEAT_WINDOW_DAYS,
  sourceOf,
  type ConsultationAction,
  type ConsultationResult,
  type StaffLead,
  type StaffLeadQuery,
  type StartMode,
  type UnverifiedInput,
} from '../bo/consultation.js';
import { followUpState, type LeadCallInput } from '../bo/lead-follow-up.js';
import { parsePublicConfig } from '../bo/public-config.js';
import type {
  ConsultationDbService,
  ConsultationUnit,
} from '../db/service/consultation-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

const STAFF_PAGE = 200;

const withFollowUp = (lead: StaffLead, hours: number, now: Date): StaffLead => {
  const { state, dueAt } = followUpState(
    {
      createdAt: new Date(lead.createdAt),
      firstContactAt: lead.firstContactAt ? new Date(lead.firstContactAt) : null,
      status: lead.status,
    },
    hours,
    now,
  );
  return { ...lead, followUp: { state, dueAt: dueAt ? dueAt.toISOString() : null } };
};
const hash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');

/** The details of an enquiry, without the code (the caller proved it, or there is none). */
export type ConsultationDetails = UnverifiedInput;

/**
 * The rules of "Talk to an adviser" (see bo/consultation.ts). Nothing here sends a text.
 *
 * - A proved number: the enquiry and its origin are saved in the same transaction that chooses the agent who
 *   follows it up, before the branch's number is returned, so no visitor ever sees a number without a record of it.
 * - An unproved number (the code never arrived): the same details are kept as a call request with no reference shown
 *   and no number returned; staff confirm it on the phone.
 * - A code asked for (21 November 2026): the enquiry is saved the moment the visitor asks for the code, so a person
 *   who never types it is still a lead staff may call. Staff are told when it becomes a proved enquiry or a call
 *   request, not for the code alone (the follow-up time limit will catch the ones left there).
 * - The agent is chosen like a new client's agent: none while the agency assigns by hand (every admin is told and
 *   picks one); otherwise the active agent given the fewest enquiries lately. The visitor is never told who.
 * - A returning number continues its open enquiry: same reference, same agent (a new one only if that agent left),
 *   one more visit; where it first came from and what they first chose stay as they were.
 * - Staff: an admin reads and works every enquiry and can give it to another agent; an agent reads and works only
 *   those given to them. Origin is never changed by staff (the database refuses it too).
 * - Each enquiry is joined to the client it becomes (the unit of the revenue share is the lead): automatically by
 *   mobile number whenever staff read enquiries (only when exactly one client has the number), or by staff by member
 *   code. Only an admin undoes a link, and the number is then not linked automatically again.
 */
export class ConsultationService {
  constructor(
    private readonly db: Pick<ConsultationDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly random: (size: number) => Uint8Array = (size) => randomBytes(size),
  ) {}

  // ---- the visitor -------------------------------------------------------------------------------

  /** Saves (or continues) the enquiry of a visitor whose number was just proved, and gives the branch's number. */
  async start(
    agencyId: string,
    input: ConsultationDetails,
    ownHost: string | null,
  ): Promise<ConsultationResult> {
    const ticket = Buffer.from(this.random(32)).toString('base64url');
    return this.db.inTransaction(agencyId, async (unit) => {
      const { manual, officePhone, officeName, oldSiteHosts } = await this.agency(
        unit,
        agencyId,
        input.office,
      );

      const open = await unit.openByPhone(agencyId, input.phone, REPEAT_WINDOW_DAYS);
      if (open) {
        const keep = open.agentId && (await unit.isActiveStaff(agencyId, open.agentId));
        const agentId = keep || manual ? null : await unit.chooseAdviser(agencyId);
        await unit.revisit(agencyId, open.id, hash(ticket), agentId);
        if (!open.verified) {
          // The first proof of an enquiry saved when the code was asked for: a new enquiry for staff (unless they
          // were already told of it as a call request) and, for the visitor, not a return.
          if (!open.callbackRequested)
            await this.tellStaff(
              unit,
              agencyId,
              agentId ?? open.agentId,
              'lead.new',
              open.reference,
            );
          await unit.appendEvent(this.event(agencyId, null, open.id, 'lead.verified'));
        } else {
          await unit.appendEvent(this.event(agencyId, null, open.id, 'lead.revisited'));
        }
        return {
          reference: open.reference,
          officePhone,
          ticket,
          returning: open.verified,
          callbackRequested: open.callbackRequested,
          visitRequested: open.visitRequested,
        };
      }

      const agentId = manual ? null : await unit.chooseAdviser(agencyId);
      const { id, reference } = await this.insert(unit, agencyId, input, ownHost, {
        agentId,
        officeName,
        oldSiteHosts,
        mode: 'verified',
        ticketHash: hash(ticket),
      });
      await this.tellStaff(unit, agencyId, agentId, 'lead.new', reference);
      await unit.appendEvent(this.event(agencyId, null, id, 'lead.created'));
      return {
        reference,
        officePhone,
        ticket,
        returning: false,
        callbackRequested: false,
        visitRequested: false,
      };
    });
  }

  /**
   * The code never arrived: keeps a call request with the same details, unverified. Nothing is returned, so the
   * request reveals nothing (not even whether the number asked before); an open enquiry for the number is reused.
   */
  async requestUnverified(agencyId: string, input: ConsultationDetails, ownHost: string | null) {
    await this.db.inTransaction(agencyId, async (unit) => {
      const open = await unit.openByPhone(agencyId, input.phone, REPEAT_WINDOW_DAYS);
      if (open) {
        await unit.requestAgain(agencyId, open.id);
        if (!open.callbackRequested)
          await this.tellStaff(unit, agencyId, open.agentId, 'lead.callback', open.reference);
        await unit.appendEvent(this.event(agencyId, null, open.id, 'lead.callback_requested'));
        return;
      }
      const { manual, officeName, oldSiteHosts } = await this.agency(unit, agencyId, input.office);
      const agentId = manual ? null : await unit.chooseAdviser(agencyId);
      const { id, reference } = await this.insert(unit, agencyId, input, ownHost, {
        agentId,
        officeName,
        oldSiteHosts,
        mode: 'callback',
        ticketHash: null,
      });
      await this.tellStaff(unit, agencyId, agentId, 'lead.callback', reference);
      await unit.appendEvent(this.event(agencyId, null, id, 'lead.created'));
    });
  }

  /**
   * The visitor asked for a code with their details: the enquiry is saved now (or the open one for the number is
   * marked), before the code is typed. Nothing is returned and nobody is told yet.
   */
  async codeAsked(agencyId: string, input: ConsultationDetails, ownHost: string | null) {
    await this.db.inTransaction(agencyId, async (unit) => {
      const open = await unit.openByPhone(agencyId, input.phone, REPEAT_WINDOW_DAYS);
      if (open) {
        await unit.markCodeSent(agencyId, open.id);
        return;
      }
      const { manual, officeName, oldSiteHosts } = await this.agency(unit, agencyId, input.office);
      const agentId = manual ? null : await unit.chooseAdviser(agencyId);
      const { id } = await this.insert(unit, agencyId, input, ownHost, {
        agentId,
        officeName,
        oldSiteHosts,
        mode: 'code',
        ticketHash: null,
      });
      await unit.appendEvent(this.event(agencyId, null, id, 'lead.created'));
    });
  }

  /**
   * What a verified visitor does next: ask to be called, dial the branch, ask for an office visit at a part of the
   * day, or open WhatsApp; and, with any of them, who the enquiry is for. A request already made is not made again.
   */
  async act(agencyId: string, reference: string, input: ConsultationAction) {
    await this.db.inTransaction(agencyId, async (unit) => {
      const lead = await unit.byTicket(agencyId, reference, hash(input.ticket));
      if (!lead) throw new AppError(404, 'NOT_FOUND');
      if (input.forWhom) await unit.setForWhom(agencyId, lead.id, input.forWhom);
      switch (input.action) {
        case 'callback':
          if (lead.callbackRequested) return;
          await unit.markCallback(agencyId, lead.id);
          await this.tellStaff(unit, agencyId, lead.agentId, 'lead.callback', reference);
          await unit.appendEvent(this.event(agencyId, null, lead.id, 'lead.callback_requested'));
          return;
        case 'visit':
          await unit.markVisit(agencyId, lead.id, input.visitTime ?? 'any');
          if (!lead.visitRequested) {
            await this.tellStaff(unit, agencyId, lead.agentId, 'lead.callback', reference);
            await unit.appendEvent(this.event(agencyId, null, lead.id, 'lead.visit_requested'));
          }
          return;
        case 'whatsapp':
          await unit.markWhatsapp(agencyId, lead.id);
          return;
        case 'call':
          if (!lead.called) await unit.markCalled(agencyId, lead.id);
          return;
      }
    });
  }

  // ---- staff -------------------------------------------------------------------------------------

  async list(actor: ProfileActor, query: StaffLeadQuery): Promise<StaffLead[]> {
    const agentId = this.scope(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.linkPending(unit, actor.agencyId);
      return this.decorateAll(
        unit,
        actor.agencyId,
        await unit.list(actor.agencyId, { ...query, agentId }, STAFF_PAGE),
      );
    });
  }

  /**
   * The enquiries that became this client, oldest first: the proof of where the client came from. The admin, or the
   * agent who looks after the client.
   */
  async ofClient(actor: ProfileActor, profileId: string): Promise<StaffLead[]> {
    const agentId = this.scope(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.clientAgent(actor.agencyId, profileId);
      if (!client || (agentId && client.agentId !== agentId))
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      await this.linkPending(unit, actor.agencyId);
      return this.decorateAll(unit, actor.agencyId, await unit.ofClient(actor.agencyId, profileId));
    });
  }

  /**
   * Staff link an enquiry to a client by member code: the admin, or the agent the enquiry is given to. A link made
   * automatically may be changed this way too (the number belonged to someone else); the change is recorded.
   */
  async linkClient(
    actor: ProfileActor,
    id: string,
    memberCode: string,
    correlationId: string,
  ): Promise<StaffLead> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const lead = await this.find(unit, actor, id);
      const profile = await unit.profileByCode(actor.agencyId, memberCode);
      if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
      if (lead.client?.profileId !== profile.id) {
        await unit.linkClient(actor.agencyId, id, profile.id, actor.accountId);
        await unit.appendEvent(
          this.event(actor.agencyId, actor.accountId, id, 'lead.linked', correlationId),
        );
      }
      return this.decorate(unit, actor.agencyId, (await unit.one(actor.agencyId, id))!);
    });
  }

  /** An admin undoes a link (a wrong number); the enquiry is then never linked automatically again. */
  async unlinkClient(actor: ProfileActor, id: string, correlationId: string): Promise<StaffLead> {
    this.adminOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const lead = await this.find(unit, actor, id);
      if (lead.client) {
        await unit.unlinkClient(actor.agencyId, id);
        await unit.appendEvent(
          this.event(actor.agencyId, actor.accountId, id, 'lead.unlinked', correlationId),
        );
      }
      return this.decorate(unit, actor.agencyId, (await unit.one(actor.agencyId, id))!);
    });
  }

  async update(
    actor: ProfileActor,
    id: string,
    change: { status: string; note?: string },
    correlationId: string,
  ): Promise<StaffLead> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.find(unit, actor, id);
      await unit.setStatus(actor.agencyId, id, {
        status: change.status,
        note: change.note ?? null,
        by: actor.accountId,
      });
      await unit.appendEvent(
        this.event(actor.agencyId, actor.accountId, id, 'lead.updated', correlationId),
      );
      return this.decorate(unit, actor.agencyId, (await unit.one(actor.agencyId, id))!);
    });
  }

  /** An admin gives an enquiry to an agent (or to another one). The agent is told. */
  async assign(
    actor: ProfileActor,
    id: string,
    agentId: string,
    correlationId: string,
  ): Promise<StaffLead> {
    this.adminOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const lead = await this.find(unit, actor, id);
      if (!(await unit.isActiveAgent(actor.agencyId, agentId)))
        throw new AppError(404, 'AGENT_NOT_FOUND');
      if (lead.adviser?.id !== agentId) {
        await unit.assign(actor.agencyId, id, agentId);
        if (agentId !== actor.accountId)
          await unit.notify(actor.agencyId, agentId, 'lead.new', lead.reference ?? '');
        await unit.appendEvent(
          this.event(actor.agencyId, actor.accountId, id, 'lead.assigned', correlationId),
        );
      }
      return this.decorate(unit, actor.agencyId, (await unit.one(actor.agencyId, id))!);
    });
  }

  // ---- helpers -----------------------------------------------------------------------------------

  /** The agency's assignment mode, and the chosen branch's number and name (else the agency's number). */
  private async agency(unit: ConsultationUnit, agencyId: string, office: number | undefined) {
    const agency = await unit.agency(agencyId);
    const config = parsePublicConfig(agency.publicConfig);
    const branch = office === undefined ? undefined : config.branches[office];
    const settings = parseSettings(agency.settings);
    return {
      manual: settings.assignment.mode === 'manual',
      oldSiteHosts: settings.leads.oldSiteHosts,
      followUpHours: settings.leads.followUpHours,
      officePhone: branch?.phone ?? config.contact?.phone ?? null,
      officeName: branch ? (branch.name.en ?? branch.name.bn ?? null) : null,
    };
  }

  /** Stores a new enquiry with a fresh reference (a clash of two random references is retried). */
  private async insert(
    unit: ConsultationUnit,
    agencyId: string,
    input: ConsultationDetails,
    ownHost: string | null,
    extra: {
      agentId: string | null;
      officeName: string | null;
      oldSiteHosts: readonly string[];
      mode: StartMode;
      ticketHash: string | null;
    },
  ): Promise<{ id: string; reference: string }> {
    const profileId = input.ref ? await unit.profileOfRef(agencyId, input.ref) : null;
    const origin = input.origin;
    for (let attempt = 0; attempt < 5; attempt++) {
      const reference = referenceFrom(this.random(8));
      const id = await unit.insert(agencyId, {
        reference,
        name: input.name,
        phone: input.phone,
        profileId,
        source: sourceOf(origin, ownHost, extra.oldSiteHosts),
        utmSource: origin?.utmSource ?? null,
        utmMedium: origin?.utmMedium ?? null,
        utmCampaign: origin?.utmCampaign ?? null,
        utmContent: origin?.utmContent ?? null,
        referrerHost: referrerHost(origin?.referrer),
        landingPath: cleanPath(origin?.landingPath),
        firstSeenAt: origin?.firstSeenAt ?? null,
        clickId: origin?.clickId ?? null,
        office: extra.officeName,
        agentId: extra.agentId,
        intent: input.intent,
        heardFrom: input.heardFrom ?? null,
        mode: extra.mode,
        ticketHash: extra.ticketHash,
      });
      if (id) return { id, reference };
    }
    throw new AppError(503, 'TRY_AGAIN');
  }

  /**
   * Staff write down a call to an enquiry they may work (the admin, or its agent): what came of it, a note, and for
   * "call me later" when. It counts as the first contact; a call that reached the person moves a new enquiry on.
   */
  async addCall(
    actor: ProfileActor,
    id: string,
    call: LeadCallInput,
    correlationId: string,
  ): Promise<StaffLead> {
    if (call.callAgainAt && new Date(call.callAgainAt) <= this.now())
      throw new AppError(400, 'VALIDATION_FAILED');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.find(unit, actor, id);
      await unit.addCall(actor.agencyId, id, call, actor.accountId);
      await unit.appendEvent(
        this.event(actor.agencyId, actor.accountId, id, 'lead.called', correlationId),
      );
      return this.decorate(unit, actor.agencyId, (await unit.one(actor.agencyId, id))!);
    });
  }

  /**
   * The follow-up round (every few minutes): an enquiry nobody tried to call within the agency's limit reminds its
   * agent (or, with none, the admins); one still not tried after a second limit tells the admins. Each is told once.
   * Returns how many reminders were added.
   */
  async remindOverdue(agencyId: string, correlationId: string): Promise<number> {
    return this.db.inTransaction(agencyId, async (unit) => {
      const { followUpHours } = await this.agency(unit, agencyId, undefined);
      const now = this.now();
      let told = 0;
      for (const lead of await unit.waitingForCall(agencyId, 500)) {
        const { state } = followUpState(
          { createdAt: lead.createdAt, firstContactAt: null, status: 'new' },
          followUpHours,
          now,
        );
        if (state === 'escalated' && !lead.escalated) {
          for (const admin of await unit.adminIds(agencyId))
            await unit.notify(agencyId, admin, 'lead.overdue', lead.reference);
          if (!lead.reminded && lead.agentId)
            await unit.notify(agencyId, lead.agentId, 'lead.overdue', lead.reference);
          await unit.markEscalated(agencyId, lead.id);
          await unit.appendEvent(
            this.event(agencyId, null, lead.id, 'lead.follow_up_escalated', correlationId),
          );
          told++;
        } else if (state === 'overdue' && !lead.reminded) {
          await this.tellStaff(unit, agencyId, lead.agentId, 'lead.overdue', lead.reference);
          await unit.markReminded(agencyId, lead.id);
          await unit.appendEvent(
            this.event(agencyId, null, lead.id, 'lead.follow_up_reminded', correlationId),
          );
          told++;
        }
      }
      return told;
    });
  }

  /** Where each enquiry stands against the agency's limit for the first call. */
  private async decorateAll(unit: ConsultationUnit, agencyId: string, leads: StaffLead[]) {
    if (leads.length === 0) return leads;
    const { followUpHours } = await this.agency(unit, agencyId, undefined);
    const now = this.now();
    return leads.map((lead) => withFollowUp(lead, followUpHours, now));
  }

  private async decorate(unit: ConsultationUnit, agencyId: string, lead: StaffLead) {
    return (await this.decorateAll(unit, agencyId, [lead]))[0]!;
  }

  /** Joins waiting enquiries to the client with the same number, and records each link. */
  private async linkPending(unit: ConsultationUnit, agencyId: string) {
    for (const link of await unit.linkPending(agencyId))
      await unit.appendEvent(this.event(agencyId, null, link.id, 'lead.linked'));
  }

  /** Null for an admin (every enquiry), the agent's own id for an agent; anyone else is refused. */
  private scope(actor: ProfileActor): string | null {
    if (actor.role === 'admin') return null;
    if (actor.role === 'agent') return actor.accountId;
    throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  /** An enquiry the actor may work; an agent is told one that is not theirs does not exist. */
  private async find(unit: ConsultationUnit, actor: ProfileActor, id: string) {
    const agentId = this.scope(actor);
    const lead = await unit.one(actor.agencyId, id);
    if (!lead || (agentId && lead.adviser?.id !== agentId)) throw new AppError(404, 'NOT_FOUND');
    return lead;
  }

  /** The agent is told; with no agent, every admin is (so someone picks one). */
  private async tellStaff(
    unit: ConsultationUnit,
    agencyId: string,
    agentId: string | null,
    template: 'lead.new' | 'lead.callback' | 'lead.overdue',
    reference: string,
  ) {
    const recipients = agentId ? [agentId] : await unit.adminIds(agencyId);
    for (const recipient of recipients) await unit.notify(agencyId, recipient, template, reference);
  }

  private adminOnly(actor: ProfileActor) {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private event(
    agencyId: string,
    actorId: string | null,
    subjectId: string,
    type: WorkflowEvent['type'],
    correlationId?: string,
  ): WorkflowEvent {
    return {
      id: this.newId(),
      agencyId,
      actorId,
      subjectId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId: correlationId ?? this.newId(),
    };
  }
}
