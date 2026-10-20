import { randomUUID } from 'node:crypto';
import { canManage, isStaff } from '../bo/access.js';
import {
  NOTIFICATION_GROUP_KINDS,
  recipientOf,
  type ConnectionListQuery,
  type ConnectionPage,
  type ConnectionRecord,
  type NotificationKind,
  type NotificationPage,
  type NotificationQuery,
  type ProfileLite,
  type ReviewQueuePage,
  type ReviewQueueQuery,
  type SendResult,
  type StaffConnectionRow,
} from '../bo/connection.js';
import type { WorkflowEvent } from '../bo/event.js';
import { DEFAULT_VISIBLE_FIELDS, type VisibleField } from '../bo/release.js';
import { decodeCursor, encodeCursor } from '../bo/review.js';
import type { ConnectionDbService, ConnectionUnit } from '../db/service/connection-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  | 'interest.requested'
  | 'interest.review_approved'
  | 'interest.review_rejected'
  | 'interest.reopened'
  | 'interest.review_reminded'
  | 'interest.accepted'
  | 'interest.declined'
  | 'interest.withdrawn'
  | 'interest.contact_shared'
>;

/** The first reminder for a request waiting for review comes after 2 days, each later one after 3. */
export const FIRST_REMINDER_SECONDS = 2 * 24 * 3600;
export const NEXT_REMINDER_SECONDS = 3 * 24 * 3600;
/** From this many reminders sent (so the third, about a week in) the admins are told as well. */
const ADMINS_FROM_REMINDER = 2;
const REMINDER_BATCH = 100;

/**
 * Connection requests and the inbox (slice 3.F, docs/features/discovery-loop.md).
 *
 * Since slice 3.H a request to a member who has a login first waits for review: the agent who looks
 * after the person asked (an admin when nobody does) approves it, and only then does the person see
 * it. Rejecting ends it as declined, which is what the asker is told. A client with no login (an
 * assisted client) is answered for by their agent anyway, so for them the request goes straight to
 * the agent without a separate review step.
 *
 * - Only a member with a published profile asks, and only someone in their released window. Anything
 *   else is reported as not found, so a profile outside the window is never confirmed to exist.
 * - There is one connection per pair. Two people asking each other end as one accepted connection
 *   (both are told). Asking again while waiting changes nothing. A declined pair stays declined. A
 *   withdrawn request can be asked again.
 * - The person asked is told in their inbox. A client managed by an agent has no login, so the agent
 *   is told, and answers for them from the client's page.
 * - Contact details stay private. After acceptance each side may share theirs with the other, and
 *   only that side can say so.
 * - Both profiles are locked in a fixed order while a request is made or answered, so two people
 *   asking each other at the same moment cannot create two connections or deadlock.
 * - Every change is an event in the same transaction.
 */
export class ConnectionService {
  constructor(
    private readonly db: Pick<ConnectionDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A member asks to connect with someone in their window. */
  async send(
    actor: ProfileActor,
    candidateId: string,
    correlationId: string,
    note: string | null = null,
  ): Promise<SendResult> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      if (candidateId === own.id) throw new AppError(404, 'PROFILE_NOT_FOUND');
      const locked = await unit.lockProfiles(actor.agencyId, [own.id, candidateId]);
      const me = locked.find((p) => p.id === own.id);
      const them = locked.find((p) => p.id === candidateId);
      if (!me || !them || !(await unit.released(actor.agencyId, me.id, them.id))) {
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      }

      // A person with a login is reached only after their agent has reviewed the request. A client
      // with no login is answered for by the agent, so the request goes straight to the agent.
      const start: 'in_review' | 'pending' =
        them.serviceMode === 'assisted' ? 'pending' : 'in_review';
      const existing = await unit.pair(actor.agencyId, me.id, them.id);
      if (!existing) {
        const id = await unit.insert(actor.agencyId, me.id, them.id, actor.accountId, start, note);
        await this.announce(unit, actor.agencyId, start, id, them, me);
        await unit.appendEvent(this.event('interest.requested', actor, id, correlationId));
        return { outcome: 'requested', connectionId: id, status: start };
      }
      if (existing.status === 'declined') throw new AppError(409, 'CONNECTION_DECLINED');
      if (existing.status === 'accepted') {
        return { outcome: 'unchanged', connectionId: existing.id, status: 'accepted' };
      }
      if (existing.status === 'withdrawn') {
        await unit.repend(
          actor.agencyId,
          existing.id,
          me.id,
          them.id,
          actor.accountId,
          start,
          note,
        );
        await this.announce(unit, actor.agencyId, start, existing.id, them, me);
        await unit.appendEvent(this.event('interest.requested', actor, existing.id, correlationId));
        return { outcome: 'requested', connectionId: existing.id, status: start };
      }
      // Waiting, from me: asking again changes nothing.
      if (existing.fromProfileId === me.id) {
        return { outcome: 'unchanged', connectionId: existing.id, status: existing.status };
      }
      // Waiting for review, from them: it is not mine to approve, and not theirs to see yet.
      if (existing.status === 'in_review') {
        return { outcome: 'unchanged', connectionId: existing.id, status: 'in_review' };
      }
      // Pending from them: their request to me and mine to them meet, which is an accepted connection.
      await unit.respond(actor.agencyId, existing.id, 'accepted', actor.accountId);
      await unit.releaseBoth(
        actor.agencyId,
        existing.fromProfileId,
        existing.toProfileId,
        actor.accountId,
      );
      await this.tell(unit, actor.agencyId, 'connection_accepted', existing.id, them, me);
      await this.tell(unit, actor.agencyId, 'connection_accepted', existing.id, me, them);
      await unit.appendEvent(this.event('interest.accepted', actor, existing.id, correlationId));
      return { outcome: 'accepted', connectionId: existing.id, status: 'accepted' };
    });
  }

  /** A member answers a request made to them. */
  async respond(
    actor: ProfileActor,
    connectionId: string,
    accept: boolean,
    correlationId: string,
  ): Promise<void> {
    this.requireMember(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      await this.decide(unit, actor, own.id, connectionId, accept, correlationId);
    });
  }

  /** A member takes back a request that has not been answered. */
  async withdraw(actor: ProfileActor, connectionId: string, correlationId: string): Promise<void> {
    this.requireMember(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      const { connection } = await this.lockedParty(unit, actor.agencyId, own.id, connectionId);
      if (connection.fromProfileId !== own.id) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      if (!(await unit.withdraw(actor.agencyId, connection.id, own.id))) {
        throw new AppError(409, 'CONNECTION_NOT_PENDING');
      }
      await unit.appendEvent(this.event('interest.withdrawn', actor, connection.id, correlationId));
    });
  }

  /** A member shares their own contact details with the other side of an accepted connection. */
  async shareContact(
    actor: ProfileActor,
    connectionId: string,
    correlationId: string,
  ): Promise<void> {
    this.requireMember(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.publishedOwn(unit, actor);
      await this.share(unit, actor, own.id, connectionId, correlationId);
    });
  }

  /** A member's connections in one box: waiting for them, waiting for the other person, or accepted. */
  async list(actor: ProfileActor, query: ConnectionListQuery): Promise<ConnectionPage> {
    this.requireMemberOrGuardian(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.viewedProfile(unit, actor);
      if (!own || own.status !== 'active') return { items: [], next: null };
      const visible = await this.visibleFields(unit, actor.agencyId, own.id);
      const rows = await unit.connections(
        actor.agencyId,
        own.id,
        query.box,
        visible,
        { limit: query.limit, after },
        this.now(),
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.connectionId })
            : null,
      };
    });
  }

  /** An account's inbox: what happened to them or to the clients they look after, newest first. */
  async notifications(actor: ProfileActor, query: NotificationQuery): Promise<NotificationPage> {
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      // Staff see names. A member sees a name only if staff let them see names at all.
      let showNames = isStaff(actor.role);
      if (actor.role === 'member' || actor.role === 'guardian') {
        const own = await this.viewedProfile(unit, actor);
        showNames = own
          ? (await this.visibleFields(unit, actor.agencyId, own.id)).includes('fullName')
          : false;
      }
      const rows = await unit.notifications(
        actor.agencyId,
        actor.accountId,
        showNames,
        { limit: query.limit, after },
        {
          kinds: query.group ? NOTIFICATION_GROUP_KINDS[query.group] : null,
          read: query.read ? query.read === 'read' : null,
          from: query.from ?? null,
          to: query.to ?? null,
          // The characters that mean something to LIKE are searched for as themselves.
          text: query.q ? query.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null,
          // Only staff look after clients; for anyone else the line is already about themselves.
          client: isStaff(actor.role) ? (query.client ?? null) : null,
        },
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
      };
    });
  }

  /** How many inbox lines the account has not read yet. */
  async unreadCount(actor: ProfileActor): Promise<number> {
    return this.db.inTransaction(actor.agencyId, (unit) =>
      unit.unreadCount(actor.agencyId, actor.accountId),
    );
  }

  /**
   * Marks the given lines, or all unread ones, as read. A line that is not the account's own, or
   * already read, is simply not touched; asking again is harmless.
   */
  async markRead(actor: ProfileActor, ids: readonly string[] | null): Promise<void> {
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await unit.markRead(actor.agencyId, actor.accountId, ids);
    });
  }

  // ---- staff, for the clients they look after -----------------------------------------------

  /** Every connection of a client, for the staff who look after them. */
  async staffList(actor: ProfileActor, clientId: string): Promise<StaffConnectionRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.managed(unit, actor, clientId, false);
      return unit.staffList(actor.agencyId, clientId, this.now());
    });
  }

  /** Staff answer a request for a client who has no login. */
  async staffRespond(
    actor: ProfileActor,
    clientId: string,
    connectionId: string,
    accept: boolean,
    correlationId: string,
  ): Promise<void> {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.managed(unit, actor, clientId, false);
      await this.decide(unit, actor, clientId, connectionId, accept, correlationId);
    });
  }

  /** Staff share an assisted client's contact details with the other side, once the client agrees. */
  async staffShareContact(
    actor: ProfileActor,
    clientId: string,
    connectionId: string,
    correlationId: string,
  ): Promise<void> {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.managed(unit, actor, clientId, false);
      await this.share(unit, actor, clientId, connectionId, correlationId);
    });
  }

  // ---- review ---------------------------------------------------------------------------------

  /** Requests waiting for this staff member's review: an admin's are all of them, an agent's their clients'. */
  async reviewQueue(actor: ProfileActor, query: ReviewQueueQuery): Promise<ReviewQueuePage> {
    this.requireStaff(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    const reader = { accountId: actor.accountId, isAdmin: actor.role === 'admin' };
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const rows = await unit.reviewQueue(
        actor.agencyId,
        reader,
        { limit: query.limit, after },
        this.now(),
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.connectionId })
            : null,
        total: await unit.reviewCount(actor.agencyId, reader),
      };
    });
  }

  /**
   * Approve a request (the person asked then sees it) or reject it (the asker is told it was
   * declined, and the pair is declined until staff reopen it). Only the agent who looks after the
   * person asked, or an admin, decides.
   */
  async review(
    actor: ProfileActor,
    connectionId: string,
    approve: boolean,
    correlationId: string,
  ): Promise<void> {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const first = await unit.byId(actor.agencyId, connectionId);
      if (!first) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      const [client] = await unit.readProfiles(actor.agencyId, [first.toProfileId]);
      if (!client || !canManage(actor, client)) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      const { connection, profiles } = await this.lockedParty(
        unit,
        actor.agencyId,
        first.toProfileId,
        connectionId,
      );
      if (!(await unit.reviewDecide(actor.agencyId, connection.id, approve, actor.accountId))) {
        throw new AppError(409, 'CONNECTION_NOT_IN_REVIEW');
      }
      const asker = profiles.find((p) => p.id === connection.fromProfileId);
      const asked = profiles.find((p) => p.id === connection.toProfileId);
      if (asker && asked) {
        if (approve) {
          await this.tell(unit, actor.agencyId, 'connection_request', connection.id, asked, asker);
          // The asker is told it went through, so a request does not seem to have vanished.
          await this.tell(
            unit,
            actor.agencyId,
            'connection_forwarded',
            connection.id,
            asker,
            asked,
          );
        } else {
          await this.tell(unit, actor.agencyId, 'connection_declined', connection.id, asker, asked);
        }
      }
      await unit.appendEvent(
        this.event(
          approve ? 'interest.review_approved' : 'interest.review_rejected',
          actor,
          connection.id,
          correlationId,
        ),
      );
    });
  }

  /**
   * Staff open a declined pair again, so either side can ask. Not the members: a decline stays
   * final for them. Staff who look after either side may do it.
   */
  async reopen(actor: ProfileActor, connectionId: string, correlationId: string): Promise<void> {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const first = await unit.byId(actor.agencyId, connectionId);
      if (!first) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      const sides = await unit.readProfiles(actor.agencyId, [
        first.fromProfileId,
        first.toProfileId,
      ]);
      if (!sides.some((p) => canManage(actor, p))) {
        throw new AppError(404, 'CONNECTION_NOT_FOUND');
      }
      await unit.lockProfiles(actor.agencyId, [first.fromProfileId, first.toProfileId]);
      if (!(await unit.reopen(actor.agencyId, connectionId))) {
        throw new AppError(409, 'CONNECTION_NOT_DECLINED');
      }
      await unit.appendEvent(this.event('interest.reopened', actor, connectionId, correlationId));
    });
  }

  /**
   * Reminds whoever must review the requests that have waited too long: the first reminder after 2
   * days, then every 3. The agent who looks after the person asked is reminded, or the admins when
   * nobody does; from the third reminder on (about a week) the admins are told as well. Run by a
   * timer, once for an agency at a time. Returns how many requests were reminded about.
   */
  async remindStale(agencyId: string, correlationId: string): Promise<number> {
    return this.db.inTransaction(agencyId, async (unit) => {
      const now = this.now();
      const due = await unit.dueReminders(
        agencyId,
        now,
        FIRST_REMINDER_SECONDS,
        NEXT_REMINDER_SECONDS,
        REMINDER_BATCH,
      );
      if (due.length === 0) return 0;
      const admins = await unit.admins(agencyId);
      for (const request of due) {
        const reviewers = new Set<string>();
        if (request.assignedAgentId) reviewers.add(request.assignedAgentId);
        if (!request.assignedAgentId || request.remindersSent >= ADMINS_FROM_REMINDER) {
          for (const admin of admins) reviewers.add(admin);
        }
        for (const account of reviewers) {
          await unit.notify(
            agencyId,
            account,
            'connection_review_reminder',
            request.id,
            request.toProfileId,
            request.fromProfileId,
            `connection_review_reminder:${request.id}:${request.remindersSent + 1}:${account}`,
          );
        }
        await unit.markReminded(agencyId, request.id, now);
        await unit.appendEvent({
          id: randomUUID(),
          agencyId,
          actorId: null,
          type: 'interest.review_reminded',
          version: 1,
          occurredAt: now.toISOString(),
          correlationId,
          subjectId: request.id,
        });
      }
      return due.length;
    });
  }

  // ------------------------------------------------------------------------------------------

  /** Answers a request made to `toProfileId`, for them (a member) or on their behalf (staff). */
  private async decide(
    unit: ConnectionUnit,
    actor: ProfileActor,
    toProfileId: string,
    connectionId: string,
    accept: boolean,
    correlationId: string,
  ) {
    const { connection, profiles } = await this.lockedParty(
      unit,
      actor.agencyId,
      toProfileId,
      connectionId,
    );
    // Only the person asked answers.
    if (connection.toProfileId !== toProfileId) throw new AppError(404, 'CONNECTION_NOT_FOUND');
    if (
      !(await unit.respond(
        actor.agencyId,
        connection.id,
        accept ? 'accepted' : 'declined',
        actor.accountId,
      ))
    ) {
      throw new AppError(409, 'CONNECTION_NOT_PENDING');
    }
    const asker = profiles.find((p) => p.id === connection.fromProfileId);
    const asked = profiles.find((p) => p.id === toProfileId);
    if (asker && asked) {
      await this.tell(
        unit,
        actor.agencyId,
        accept ? 'connection_accepted' : 'connection_declined',
        connection.id,
        asker,
        asked,
      );
      // An accepted pair is told on both sides, and each is now a candidate of the other.
      if (accept) {
        await unit.releaseBoth(
          actor.agencyId,
          connection.fromProfileId,
          connection.toProfileId,
          actor.accountId,
        );
        await this.tell(unit, actor.agencyId, 'connection_accepted', connection.id, asked, asker);
      }
    }
    await unit.appendEvent(
      this.event(
        accept ? 'interest.accepted' : 'interest.declined',
        actor,
        connection.id,
        correlationId,
      ),
    );
  }

  private async share(
    unit: ConnectionUnit,
    actor: ProfileActor,
    profileId: string,
    connectionId: string,
    correlationId: string,
  ) {
    const { connection, profiles } = await this.lockedParty(
      unit,
      actor.agencyId,
      profileId,
      connectionId,
    );
    const side = connection.fromProfileId === profileId ? 'from' : 'to';
    if (!(await unit.share(actor.agencyId, connection.id, profileId, side))) {
      throw new AppError(409, 'CONNECTION_NOT_ACCEPTED');
    }
    // The other side is told, so they know there is something new to look at.
    const sharer = profiles.find((p) => p.id === profileId);
    const other = profiles.find((p) => p.id !== profileId);
    if (sharer && other) {
      await this.tell(unit, actor.agencyId, 'contact_shared', connection.id, other, sharer);
    }
    await unit.appendEvent(
      this.event('interest.contact_shared', actor, connection.id, correlationId),
    );
  }

  /**
   * The connection if this profile is one of its two sides (otherwise not found), with both profiles
   * locked in a fixed order and the connection read again under those locks. Every change to a
   * connection is made under both locks, so two changes to one pair never interleave or deadlock.
   */
  private async lockedParty(
    unit: ConnectionUnit,
    agencyId: string,
    profileId: string,
    connectionId: string,
  ) {
    const first: ConnectionRecord | null = await unit.byId(agencyId, connectionId);
    if (!first || (first.fromProfileId !== profileId && first.toProfileId !== profileId)) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND');
    }
    const profiles = await unit.lockProfiles(agencyId, [first.fromProfileId, first.toProfileId]);
    const connection = await unit.byId(agencyId, connectionId);
    if (!connection) throw new AppError(404, 'CONNECTION_NOT_FOUND');
    return { connection, profiles };
  }

  /**
   * Tells the right people about a new request. One that starts in review goes to the agent who
   * looks after the person asked, or to the admins when nobody does. One that starts pending goes to
   * the person asked, or for a client with no login to their agent; with no agent either, the
   * admins, so a request is never left with nobody.
   */
  private async announce(
    unit: ConnectionUnit,
    agencyId: string,
    start: 'in_review' | 'pending',
    connectionId: string,
    recipient: ProfileLite,
    about: ProfileLite,
  ) {
    if (start === 'pending' && recipientOf(recipient)) {
      return this.tell(unit, agencyId, 'connection_request', connectionId, recipient, about);
    }
    const kind: NotificationKind =
      start === 'in_review' ? 'connection_review' : 'connection_request';
    if (start === 'pending')
      await this.tellGuardian(unit, agencyId, kind, connectionId, recipient, about);
    const accounts = recipient.assignedAgentId
      ? [recipient.assignedAgentId]
      : await unit.admins(agencyId);
    for (const account of accounts) {
      await unit.notify(
        agencyId,
        account,
        kind,
        connectionId,
        recipient.id,
        about.id,
        `${kind}:${connectionId}:${randomUUID()}`,
      );
    }
  }

  /** The client's guardian sees proposals arrive and get answered, to give advice. */
  private async tellGuardian(
    unit: ConnectionUnit,
    agencyId: string,
    kind: NotificationKind,
    connectionId: string,
    recipient: ProfileLite,
    about: ProfileLite,
  ) {
    const guardian = await unit.guardianAccount(agencyId, recipient.id);
    if (!guardian) return;
    await unit.notify(
      agencyId,
      guardian,
      kind,
      connectionId,
      recipient.id,
      about.id,
      `${kind}:${connectionId}:${randomUUID()}`,
    );
  }

  /** Tells whoever looks after `recipient` that something happened with `about`. */
  private async tell(
    unit: ConnectionUnit,
    agencyId: string,
    kind: NotificationKind,
    connectionId: string,
    recipient: ProfileLite,
    about: ProfileLite,
  ) {
    const account = recipientOf(recipient);
    if (
      kind === 'connection_request' ||
      kind === 'connection_accepted' ||
      kind === 'connection_declined'
    )
      await this.tellGuardian(unit, agencyId, kind, connectionId, recipient, about);
    // The key only has to be unique for the recipient; everything here happens in one transaction.
    if (account) {
      await unit.notify(
        agencyId,
        account,
        kind,
        connectionId,
        recipient.id,
        about.id,
        `${kind}:${connectionId}:${randomUUID()}`,
      );
    }
  }

  /** The member's own profile, which must be published to take part. */
  private async publishedOwn(unit: ConnectionUnit, actor: ProfileActor) {
    const own = await unit.ownProfile(actor.agencyId, actor.accountId);
    if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
    if (own.status !== 'active') throw new AppError(409, 'PROFILE_NOT_PUBLISHED');
    return own;
  }

  /** A client this staff member may manage, and, when asked, one who has no login of their own. */
  private async managed(
    unit: ConnectionUnit,
    actor: ProfileActor,
    clientId: string,
    assistedOnly: boolean,
  ) {
    const [client] = await unit.readProfiles(actor.agencyId, [clientId]);
    if (!client || !canManage(actor, client)) throw new AppError(404, 'PROFILE_NOT_FOUND');
    // Only when asked for: a caller that needs a client with no login of their own.
    if (assistedOnly && client.serviceMode !== 'assisted')
      throw new AppError(403, 'PROFILE_SELF_SERVICE');
    return client;
  }

  private async visibleFields(
    unit: ConnectionUnit,
    agencyId: string,
    clientId: string,
  ): Promise<readonly VisibleField[]> {
    return (await unit.settings(agencyId, clientId))?.visibleFields ?? DEFAULT_VISIBLE_FIELDS;
  }

  /** The profile whose proposals are read: the member's own, or the one a guardian looks after. */
  private viewedProfile(unit: ConnectionUnit, actor: ProfileActor) {
    return actor.role === 'guardian'
      ? unit.guardedProfile(actor.agencyId, actor.accountId)
      : unit.ownProfile(actor.agencyId, actor.accountId);
  }

  private requireMemberOrGuardian(actor: ProfileActor) {
    if (actor.role !== 'member' && actor.role !== 'guardian')
      throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private requireStaff(actor: ProfileActor) {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
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
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
      subjectId,
    };
  }
}

// `canManage` reads these two fields only; a ProfileLite carries them.
export type { ProfileLite };
