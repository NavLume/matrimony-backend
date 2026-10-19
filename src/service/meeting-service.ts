import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import type {
  Agenda,
  FeedbackInput,
  FollowUpInput,
  FollowUpRow,
  MeetingInput,
  MeetingPatch,
  MeetingPerson,
  MeetingRow,
  MemberMeeting,
  NoteRow,
} from '../bo/meeting.js';
import type { MeetingProfile, RawMeeting } from '../db/raw/repository/meeting-repository.js';
import type { MeetingDbService, MeetingUnit } from '../db/service/meeting-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  | 'meeting.scheduled'
  | 'meeting.changed'
  | 'meeting.confirmed'
  | 'meeting.feedback'
  | 'note.added'
  | 'followup.added'
  | 'followup.done'
>;

/** Staff may work with a side when they look after it (an admin: any). */
const looksAfter = (actor: ProfileActor, side: { agentId: string | null }) =>
  canManage({ accountId: actor.accountId, role: actor.role }, { assignedAgentId: side.agentId });

/**
 * The rules for meetings, notes and follow-ups (see bo/meeting.ts).
 *
 * - Staff work on the clients they look after (an admin on all). Anyone else gets "not found", so an
 *   agent cannot learn that another agent's client exists.
 * - A meeting is set only for an accepted proposal, by staff who look after one of its two sides.
 * - Feedback for a side is recorded and read only by staff who look after that side.
 * - A client sees when and where, never feedback or notes.
 */
export class MeetingService {
  constructor(
    private readonly db: Pick<MeetingDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  // ---- meetings ---------------------------------------------------------------------------

  async schedule(
    actor: ProfileActor,
    connectionId: string,
    input: MeetingInput,
    correlationId: string,
  ): Promise<MeetingRow> {
    this.staffOnly(actor);
    // A few minutes' grace, for the difference between a phone's clock and the server's.
    if (Date.parse(input.scheduledAt) < this.now().getTime() - 10 * 60_000)
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'scheduledAt', code: 'past' }],
      });
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const interest = await unit.interest(actor.agencyId, connectionId);
      if (!interest) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      const [a, b] = await Promise.all([
        unit.profileById(actor.agencyId, interest.senderId),
        unit.profileById(actor.agencyId, interest.recipientId),
      ]);
      if (!a || !b || !(this.manages(actor, a) || this.manages(actor, b)))
        throw new AppError(404, 'CONNECTION_NOT_FOUND');
      if (interest.status !== 'accepted') throw new AppError(409, 'CONNECTION_NOT_ACCEPTED');
      const id = this.newId();
      // The other side has to confirm unless both clients have the same agent, or an admin sets it.
      const sides = [a, b].map((p) => ({ profileId: p.id, agentId: p.assignedAgentId }));
      const proposing = this.needsConfirmation(actor, sides);
      const mine = sides.find((side) => looksAfter(actor, side));
      await unit.insertMeeting(actor.agencyId, {
        id,
        interestId: connectionId,
        scheduledAt: input.scheduledAt,
        kind: input.kind,
        place: input.place ?? null,
        note: input.note ?? null,
        createdBy: actor.accountId,
        status: proposing ? 'proposed' : 'scheduled',
        proposedSide: proposing ? (mine?.profileId ?? sides[0]!.profileId) : null,
      });
      await unit.notifyMeeting(actor.agencyId, id, connectionId, actor.accountId);
      await unit.appendEvent(this.event('meeting.scheduled', actor, id, correlationId));
      return this.staffView(unit, actor, [(await unit.meeting(actor.agencyId, id))!]).then(
        (rows) => rows[0]!,
      );
    });
  }

  async change(
    actor: ProfileActor,
    meetingId: string,
    patch: MeetingPatch,
    correlationId: string,
  ): Promise<MeetingRow> {
    this.staffOnly(actor);
    this.notInThePast(patch.scheduledAt);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const meeting = await this.meetingOf(unit, actor, meetingId);
      if (meeting.status !== 'scheduled' && meeting.status !== 'proposed')
        throw new AppError(409, 'MEETING_CLOSED');
      const { status, ...rest } = patch;
      if (status === 'done' && meeting.status !== 'scheduled')
        throw new AppError(409, 'MEETING_NOT_CONFIRMED');
      // A meeting is done only once its time has come.
      if (status === 'done' && Date.parse(meeting.scheduledAt) > this.now().getTime())
        throw new AppError(409, 'MEETING_NOT_HELD_YET');
      const update: Parameters<MeetingUnit['updateMeeting']>[2] = { ...rest, status };
      // A change to when, where or what kind has to be answered by the other side again.
      const material =
        patch.scheduledAt !== undefined || patch.place !== undefined || patch.kind !== undefined;
      if (material && status === undefined) {
        const sides = meeting.sides;
        const mine = sides.find((side) => looksAfter(actor, side));
        const answering = this.canAnswer(actor, meeting);
        if (actor.role === 'admin') {
          // An admin's change stands.
          update.status = 'scheduled';
          update.proposedSide = null;
        } else if (meeting.status === 'proposed') {
          // The side that proposed keeps it; the other side's new time becomes their proposal.
          if (answering && mine) update.proposedSide = mine.profileId;
        } else if (this.needsConfirmation(actor, sides) && mine) {
          update.status = 'proposed';
          update.proposedSide = mine.profileId;
        }
      }
      if (!(await unit.updateMeeting(actor.agencyId, meetingId, update)))
        throw new AppError(409, 'MEETING_CLOSED');
      // Both people hear about a new time, a new place or a cancellation, not about a note to the office.
      if (material || status === 'cancelled')
        await unit.notifyMeeting(actor.agencyId, meetingId, meeting.connectionId, actor.accountId);
      await unit.appendEvent(this.event('meeting.changed', actor, meetingId, correlationId));
      const fresh = (await unit.meeting(actor.agencyId, meetingId))!;
      return (await this.staffView(unit, actor, [fresh]))[0]!;
    });
  }

  /** The other side confirms a proposed meeting: it is scheduled now. */
  async confirm(
    actor: ProfileActor,
    meetingId: string,
    correlationId: string,
  ): Promise<MeetingRow> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const meeting = await this.meetingOf(unit, actor, meetingId);
      if (meeting.status !== 'proposed') throw new AppError(409, 'MEETING_NOT_PROPOSED');
      if (!this.canAnswer(actor, meeting)) throw new AppError(403, 'MEETING_OWN_PROPOSAL');
      await this.confirmed(unit, actor, meeting, correlationId);
      const fresh = (await unit.meeting(actor.agencyId, meetingId))!;
      return (await this.staffView(unit, actor, [fresh]))[0]!;
    });
  }

  /** A client who signs in confirms a meeting the other side proposed. */
  async confirmAsClient(
    actor: ProfileActor,
    meetingId: string,
    correlationId: string,
  ): Promise<void> {
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const { meeting } = await this.clientAnswer(unit, actor, meetingId);
      await this.confirmed(unit, actor, meeting, correlationId);
    });
  }

  /** A client who signs in suggests another time: it becomes their proposal and the other side answers. */
  async suggestAsClient(
    actor: ProfileActor,
    meetingId: string,
    scheduledAt: string,
    correlationId: string,
  ): Promise<void> {
    this.notInThePast(scheduledAt);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const { meeting, own } = await this.clientAnswer(unit, actor, meetingId);
      await unit.updateMeeting(actor.agencyId, meetingId, { scheduledAt, proposedSide: own.id });
      await unit.notifyMeeting(actor.agencyId, meetingId, meeting.connectionId, actor.accountId);
      await unit.appendEvent(this.event('meeting.changed', actor, meetingId, correlationId));
    });
  }

  async recordFeedback(
    actor: ProfileActor,
    meetingId: string,
    profileId: string,
    input: FeedbackInput,
    correlationId: string,
  ): Promise<MeetingRow> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const meeting = await this.meetingOf(unit, actor, meetingId);
      const side = meeting.sides.find((s) => s.profileId === profileId);
      if (!side || !looksAfter(actor, side)) throw new AppError(404, 'MEETING_NOT_FOUND');
      if (meeting.status !== 'done') throw new AppError(409, 'MEETING_NOT_DONE');
      await unit.saveFeedback(actor.agencyId, meetingId, profileId, input, actor.accountId);
      await unit.appendEvent(this.event('meeting.feedback', actor, meetingId, correlationId));
      return (await this.staffView(unit, actor, [meeting]))[0]!;
    });
  }

  /** The meetings of one client's proposals. */
  async forClient(actor: ProfileActor, profileId: string): Promise<MeetingRow[]> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.clientOf(unit, actor, profileId);
      return this.staffView(unit, actor, await unit.meetingsOfProfile(actor.agencyId, profileId));
    });
  }

  /** A client's own meetings: when and where, with the other person. */
  async mine(actor: ProfileActor): Promise<MemberMeeting[]> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own =
        actor.role === 'guardian'
          ? await unit.guardedProfile(actor.agencyId, actor.accountId)
          : await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
      const rows = await unit.meetingsOfMember(actor.agencyId, own.id);
      return rows.map((m) => {
        const other = m.sides.find((s) => s.profileId !== own.id)!;
        return {
          id: m.id,
          canRespond:
            actor.role === 'member' && m.status === 'proposed' && m.proposedSide !== own.id,
          scheduledAt: m.scheduledAt,
          kind: m.kind,
          place: m.place,
          note: m.note,
          status: m.status,
          other: {
            profileId: other.profileId,
            memberCode: other.memberCode,
            fullName: other.fullName,
          },
        };
      });
    });
  }

  // ---- notes ------------------------------------------------------------------------------

  async notes(actor: ProfileActor, profileId: string): Promise<NoteRow[]> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.clientOf(unit, actor, profileId);
      return unit.notes(actor.agencyId, profileId);
    });
  }

  async addNote(
    actor: ProfileActor,
    profileId: string,
    body: string,
    correlationId: string,
  ): Promise<NoteRow[]> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.clientOf(unit, actor, profileId);
      const id = this.newId();
      await unit.insertNote(actor.agencyId, { id, profileId, body, authorId: actor.accountId });
      await unit.appendEvent(this.event('note.added', actor, id, correlationId));
      return unit.notes(actor.agencyId, profileId);
    });
  }

  // ---- follow-ups -------------------------------------------------------------------------

  async followUps(actor: ProfileActor, profileId: string): Promise<FollowUpRow[]> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.clientOf(unit, actor, profileId);
      return unit.followUpsOfProfile(actor.agencyId, profileId);
    });
  }

  async addFollowUp(
    actor: ProfileActor,
    profileId: string,
    input: FollowUpInput,
    correlationId: string,
  ): Promise<FollowUpRow[]> {
    this.staffOnly(actor);
    if (Number.isNaN(Date.parse(input.dueOn)))
      throw new AppError(400, 'INVALID_REQUEST', { fields: [{ path: 'dueOn', code: 'invalid' }] });
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.clientOf(unit, actor, profileId);
      const id = this.newId();
      await unit.insertFollowUp(actor.agencyId, {
        id,
        profileId,
        dueOn: input.dueOn,
        text: input.text,
        // It is the agent's reminder. An admin adding one for a client nobody looks after keeps it.
        assignedTo: profile.assignedAgentId ?? actor.accountId,
        createdBy: actor.accountId,
      });
      await unit.appendEvent(this.event('followup.added', actor, id, correlationId));
      return unit.followUpsOfProfile(actor.agencyId, profileId);
    });
  }

  async completeFollowUp(
    actor: ProfileActor,
    followUpId: string,
    correlationId: string,
  ): Promise<FollowUpRow[]> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const found = await unit.followUp(actor.agencyId, followUpId);
      if (!found) throw new AppError(404, 'FOLLOW_UP_NOT_FOUND');
      await this.clientOf(unit, actor, found.profileId);
      if (found.done) throw new AppError(409, 'FOLLOW_UP_DONE');
      await unit.markFollowUpDone(actor.agencyId, followUpId, actor.accountId);
      await unit.appendEvent(this.event('followup.done', actor, followUpId, correlationId));
      return unit.followUpsOfProfile(actor.agencyId, found.profileId);
    });
  }

  // ---- the agenda -------------------------------------------------------------------------

  /** What waits for this staff member: their meetings and their follow-ups. */
  async agenda(actor: ProfileActor): Promise<Agenda> {
    this.staffOnly(actor);
    const mine = actor.role === 'admin' ? null : actor.accountId;
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const [raw, followUps] = await Promise.all([
        unit.agendaMeetings(actor.agencyId, mine),
        unit.openFollowUps(actor.agencyId, mine),
      ]);
      const meetings = await this.staffView(unit, actor, raw);
      return {
        meetings,
        followUps,
        attention:
          followUps.filter((f) => f.due).length +
          meetings.filter(
            (m) =>
              m.awaitingOutcome ||
              m.canRespond ||
              (m.status === 'done' && m.people.some((p) => p.managed && !p.feedback)),
          ).length,
      };
    });
  }

  // ---- helpers ----------------------------------------------------------------------------

  private notInThePast(scheduledAt: string | undefined) {
    // A few minutes' grace, for the difference between a phone's clock and the server's.
    if (scheduledAt !== undefined && Date.parse(scheduledAt) < this.now().getTime() - 10 * 60_000)
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'scheduledAt', code: 'past' }],
      });
  }

  /**
   * Whether a meeting set by this staff member has to be answered by the other side: not when an admin
   * sets it, and not when both clients have the same agent.
   */
  private needsConfirmation(
    actor: ProfileActor,
    sides: readonly { agentId: string | null }[],
  ): boolean {
    if (actor.role === 'admin') return false;
    const [first, second] = sides;
    return !(first?.agentId && first.agentId === second?.agentId);
  }

  /** The staff member may confirm a proposed meeting: they (or an admin) look after the side that did not propose it. */
  private canAnswer(actor: ProfileActor, meeting: RawMeeting): boolean {
    if (meeting.status !== 'proposed') return false;
    if (actor.role === 'admin') return true;
    return meeting.sides.some(
      (side) => side.profileId !== meeting.proposedSide && looksAfter(actor, side),
    );
  }

  private async confirmed(
    unit: MeetingUnit,
    actor: ProfileActor,
    meeting: RawMeeting,
    correlationId: string,
  ) {
    await unit.updateMeeting(actor.agencyId, meeting.id, {
      status: 'scheduled',
      proposedSide: null,
      confirmedBy: actor.accountId,
    });
    await unit.notifyMeeting(actor.agencyId, meeting.id, meeting.connectionId, actor.accountId);
    await unit.appendEvent(this.event('meeting.confirmed', actor, meeting.id, correlationId));
  }

  /** The proposed meeting a signed-in client may answer: it must be with them and proposed by the other side. */
  private async clientAnswer(unit: MeetingUnit, actor: ProfileActor, meetingId: string) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    const own = await unit.ownProfile(actor.agencyId, actor.accountId);
    if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
    const meeting = await unit.meeting(actor.agencyId, meetingId);
    if (!meeting || !meeting.sides.some((side) => side.profileId === own.id))
      throw new AppError(404, 'MEETING_NOT_FOUND');
    if (meeting.status !== 'proposed') throw new AppError(409, 'MEETING_NOT_PROPOSED');
    if (meeting.proposedSide === own.id) throw new AppError(403, 'MEETING_OWN_PROPOSAL');
    return { meeting, own };
  }

  private staffOnly(actor: ProfileActor) {
    if (actor.role === 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private manages(actor: ProfileActor, profile: MeetingProfile) {
    return looksAfter(actor, { agentId: profile.assignedAgentId });
  }

  /** The client the actor looks after, or "not found". */
  private async clientOf(unit: MeetingUnit, actor: ProfileActor, profileId: string) {
    const profile = await unit.profileById(actor.agencyId, profileId);
    if (!profile || !this.manages(actor, profile)) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  /** The meeting, if the actor looks after one of its two sides. */
  private async meetingOf(unit: MeetingUnit, actor: ProfileActor, meetingId: string) {
    const meeting = await unit.meeting(actor.agencyId, meetingId);
    if (!meeting || !meeting.sides.some((s) => looksAfter(actor, s)))
      throw new AppError(404, 'MEETING_NOT_FOUND');
    return meeting;
  }

  /** Staff's view: each side's feedback only for the sides the staff member looks after. */
  private async staffView(
    unit: MeetingUnit,
    actor: ProfileActor,
    raw: RawMeeting[],
  ): Promise<MeetingRow[]> {
    const feedback = await unit.feedbackFor(
      actor.agencyId,
      raw.map((m) => m.id),
    );
    return raw.map((m) => {
      const person = (index: 0 | 1): MeetingPerson => {
        const side = m.sides[index];
        const managed = looksAfter(actor, side);
        return {
          profileId: side.profileId,
          memberCode: side.memberCode,
          fullName: side.fullName,
          managed,
          feedback: managed ? (feedback.get(`${m.id}:${side.profileId}`) ?? null) : null,
        };
      };
      return {
        id: m.id,
        connectionId: m.connectionId,
        scheduledAt: m.scheduledAt,
        kind: m.kind,
        place: m.place,
        note: m.note,
        status: m.status,
        createdBy: m.createdBy,
        awaitingOutcome: m.status === 'scheduled' && m.past,
        canRespond: this.canAnswer(actor, m),
        people: [person(0), person(1)],
      };
    });
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
