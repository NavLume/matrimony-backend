import { randomUUID } from 'node:crypto';
import { canManage, isStaff } from '../bo/access.js';
import {
  CHAT_PAGE_SIZE,
  CHAT_RETENTION_DAYS,
  maskContacts,
  type ChatMessage,
  type ChatMessagePage,
  type ChatSummary,
  type StaffChatRow,
  type StaffMessagePage,
} from '../bo/chat.js';
import type { WorkflowEvent } from '../bo/event.js';
import { DEFAULT_VISIBLE_FIELDS } from '../bo/release.js';
import { decodeCursor, encodeCursor } from '../bo/review.js';
import type {
  ChatProfile,
  ConversationRow,
  ListedConversation,
} from '../db/raw/repository/chat-repository.js';
import type { ChatDbService, ChatUnit } from '../db/service/chat-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  | 'chat.requested'
  | 'chat.accepted'
  | 'chat.ended'
  | 'chat.reported'
  | 'chat.staff_read'
  | 'chat.invited'
>;

const DAY_MS = 24 * 3600 * 1000;

/**
 * The rules of chat between two clients (see bo/chat.ts).
 *
 * - Only members with a login chat, and only after an accepted proposal that both sides agree to chat on.
 * - A message goes through only while the conversation is active, the agency has chat on and both
 *   profiles are published.
 * - Staff never see the text unless the conversation was reported or one of the two people invited the
 *   staff member in. Every reading is logged.
 */
export class ChatService {
  constructor(
    private readonly db: Pick<ChatDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  // ------------------------------------------------------------------ a member's conversations

  async list(actor: ProfileActor): Promise<{ enabled: boolean; items: ChatSummary[] }> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const enabled = await unit.chatEnabled(actor.agencyId);
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own) return { enabled, items: [] };
      const rows = await unit.listFor(actor.agencyId, own.id);
      const showNames = await this.showNames(unit, actor.agencyId, own.id);
      const items: ChatSummary[] = [];
      for (const row of rows)
        items.push(await this.summary(unit, actor, own, row, enabled, showNames));
      return { enabled, items };
    });
  }

  /** Asks the other side of an accepted proposal to chat. If they already asked, the chat starts. */
  async request(
    actor: ProfileActor,
    interestId: string,
    correlationId: string,
  ): Promise<ChatSummary> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      if (!(await unit.chatEnabled(actor.agencyId))) throw new AppError(409, 'CHAT_DISABLED');
      const own = await this.mine(unit, actor);
      if (own.status !== 'active') throw new AppError(409, 'PROFILE_NOT_PUBLISHED');
      const interest = await unit.interest(actor.agencyId, interestId);
      if (
        !interest ||
        interest.status !== 'accepted' ||
        (interest.senderProfileId !== own.id && interest.recipientProfileId !== own.id)
      )
        throw new AppError(404, 'CONNECTION_NOT_FOUND');
      const otherId =
        interest.senderProfileId === own.id
          ? interest.recipientProfileId
          : interest.senderProfileId;
      const other = await unit.profileById(actor.agencyId, otherId);
      // A client with no login cannot chat; giving them a login makes them eligible.
      if (!other || other.status !== 'active' || !other.ownerAccountId)
        throw new AppError(409, 'CHAT_NOT_AVAILABLE');

      let conversation = await unit.byInterest(actor.agencyId, interestId);
      if (!conversation) {
        const id = this.newId();
        await unit.insertConversation(actor.agencyId, {
          id,
          interestId,
          profileA: interest.senderProfileId,
          profileB: interest.recipientProfileId,
          requestedBy: own.id,
        });
        await this.tell(unit, actor.agencyId, other, 'chat.requested', id, own);
        await unit.appendEvent(this.event('chat.requested', actor, id, correlationId));
      } else if (conversation.status === 'requested') {
        if (conversation.requestedBy !== own.id) {
          await unit.activate(actor.agencyId, conversation.id);
          await this.tellById(
            unit,
            actor.agencyId,
            conversation.requestedBy,
            'chat.accepted',
            conversation.id,
            other,
          );
          await unit.appendEvent(
            this.event('chat.accepted', actor, conversation.id, correlationId),
          );
        }
      } else if (conversation.status === 'ended') {
        if (
          !['declined', 'ended_by_member', 'profile_unavailable'].includes(
            conversation.endReason ?? '',
          )
        )
          throw new AppError(409, 'CHAT_NOT_ALLOWED');
        await unit.reopen(actor.agencyId, conversation.id, own.id);
        await this.tell(unit, actor.agencyId, other, 'chat.requested', conversation.id, own);
        await unit.appendEvent(this.event('chat.requested', actor, conversation.id, correlationId));
      }
      conversation = (await unit.byInterest(actor.agencyId, interestId))!;
      return this.summaryOf(unit, actor, own, conversation.id);
    });
  }

  async respond(
    actor: ProfileActor,
    chatId: string,
    accept: boolean,
    correlationId: string,
  ): Promise<ChatSummary> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.mine(unit, actor);
      const conversation = await this.participantIn(unit, actor, own, chatId, true);
      if (conversation.status !== 'requested' || conversation.requestedBy === own.id)
        throw new AppError(409, 'CHAT_NOT_PENDING');
      if (accept) {
        await unit.activate(actor.agencyId, chatId);
        const other = await unit.profileById(actor.agencyId, conversation.requestedBy);
        if (other) await this.tell(unit, actor.agencyId, other, 'chat.accepted', chatId, own);
        await unit.appendEvent(this.event('chat.accepted', actor, chatId, correlationId));
      } else {
        await unit.end(actor.agencyId, chatId, 'declined', own.id);
        await unit.appendEvent(this.event('chat.ended', actor, chatId, correlationId));
      }
      return this.summaryOf(unit, actor, own, chatId);
    });
  }

  /** One page of messages, newest first. Opening the newest page marks the other person's as read. */
  async messages(
    actor: ProfileActor,
    chatId: string,
    after: string | undefined,
  ): Promise<ChatMessagePage> {
    this.requireMember(actor);
    const cursor = after ? decodeCursor(after) : null;
    if (after && !cursor) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.mine(unit, actor);
      await this.participantIn(unit, actor, own, chatId, false);
      if (!after) await unit.markRead(actor.agencyId, chatId, own.id);
      const rows = await unit.messages(actor.agencyId, chatId, {
        limit: CHAT_PAGE_SIZE,
        after: cursor,
      });
      const items = rows.slice(0, CHAT_PAGE_SIZE);
      const last = items.at(-1);
      return {
        chat: await this.summaryOf(unit, actor, own, chatId),
        items: items.map((m): ChatMessage => ({
          id: m.id,
          mine: m.senderProfileId === own.id,
          body: m.body,
          masked: m.masked,
          createdAt: m.createdAt,
          read: m.read,
        })),
        next:
          rows.length > CHAT_PAGE_SIZE && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
      };
    });
  }

  async send(actor: ProfileActor, chatId: string, text: string): Promise<ChatMessage> {
    this.requireMember(actor);
    const { body, masked } = maskContacts(text);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.mine(unit, actor);
      const conversation = await this.participantIn(unit, actor, own, chatId, true);
      if (conversation.status !== 'active') throw new AppError(409, 'CHAT_NOT_ACTIVE');
      const otherId =
        conversation.profileA === own.id ? conversation.profileB : conversation.profileA;
      const other = (await unit.profileById(actor.agencyId, otherId))!;
      if (
        !(await unit.chatEnabled(actor.agencyId)) ||
        own.status !== 'active' ||
        other.status !== 'active'
      )
        throw new AppError(409, 'CHAT_UNAVAILABLE');
      // The other person is told about the first message they have not read; the next ones only add to it.
      const unread = await unit.unreadFrom(actor.agencyId, chatId, own.id);
      const id = this.newId();
      await unit.insertMessage(actor.agencyId, {
        id,
        conversationId: chatId,
        sender: own.id,
        body,
        masked,
      });
      if (unread === 0) await this.tell(unit, actor.agencyId, other, 'chat.message', chatId, own);
      return { id, mine: true, body, masked, createdAt: this.now().toISOString(), read: false };
    });
  }

  /** Ends the conversation, or ends it and blocks the other person, who cannot ask again. */
  async end(
    actor: ProfileActor,
    chatId: string,
    block: boolean,
    correlationId: string,
  ): Promise<ChatSummary> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.mine(unit, actor);
      const conversation = await this.participantIn(unit, actor, own, chatId, true);
      if (conversation.status !== 'ended') {
        await unit.end(actor.agencyId, chatId, block ? 'blocked' : 'ended_by_member', own.id);
        await unit.appendEvent(this.event('chat.ended', actor, chatId, correlationId));
      }
      return this.summaryOf(unit, actor, own, chatId);
    });
  }

  /** Tells the agents and admins about a conversation, so they can look at it and act. */
  async report(
    actor: ProfileActor,
    chatId: string,
    reason: string,
    correlationId: string,
  ): Promise<void> {
    this.requireMember(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.mine(unit, actor);
      const conversation = await this.participantIn(unit, actor, own, chatId, false);
      await unit.insertReport(actor.agencyId, {
        id: this.newId(),
        conversationId: chatId,
        reportedBy: own.id,
        reason,
      });
      const otherId =
        conversation.profileA === own.id ? conversation.profileB : conversation.profileA;
      const other = (await unit.profileById(actor.agencyId, otherId))!;
      for (const account of await unit.reportRecipients(actor.agencyId, own.id, other.id)) {
        await unit.notify(
          actor.agencyId,
          account,
          'chat.reported',
          { conversationId: chatId, forProfileId: own.id, aboutProfileId: other.id },
          `chat-reported:${chatId}:${this.newId()}`,
        );
      }
      await unit.appendEvent(this.event('chat.reported', actor, chatId, correlationId));
    });
  }

  /** Invites the person's own agent into the conversation. Both people then see that the agent is in it. */
  async invite(actor: ProfileActor, chatId: string, correlationId: string): Promise<ChatSummary> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.mine(unit, actor);
      const conversation = await this.participantIn(unit, actor, own, chatId, false);
      if (conversation.status === 'ended') throw new AppError(409, 'CHAT_NOT_ACTIVE');
      if (!own.assignedAgentId) throw new AppError(409, 'NO_AGENT');
      await unit.addChaperone(actor.agencyId, chatId, own.assignedAgentId, own.id);
      const otherId =
        conversation.profileA === own.id ? conversation.profileB : conversation.profileA;
      await unit.notify(
        actor.agencyId,
        own.assignedAgentId,
        'chat.invited',
        { conversationId: chatId, forProfileId: own.id, aboutProfileId: otherId },
        `chat-invited:${chatId}:${this.newId()}`,
      );
      await unit.appendEvent(this.event('chat.invited', actor, chatId, correlationId));
      return this.summaryOf(unit, actor, own, chatId);
    });
  }

  async uninvite(actor: ProfileActor, chatId: string): Promise<ChatSummary> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.mine(unit, actor);
      await this.participantIn(unit, actor, own, chatId, false);
      if (own.assignedAgentId)
        await unit.removeChaperone(actor.agencyId, chatId, own.assignedAgentId);
      return this.summaryOf(unit, actor, own, chatId);
    });
  }

  // ------------------------------------------------------------------ staff

  /** A client's conversations: that they exist and how active, never the text. */
  async staffChats(actor: ProfileActor, profileId: string): Promise<StaffChatRow[]> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.managed(unit, actor, profileId);
      const rows = await unit.staffList(actor.agencyId, profile.id, actor.accountId);
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        endReason: row.endReason,
        other: row.other,
        requestedAt: row.requestedAt,
        lastMessageAt: row.lastMessageAt,
        messageCount: row.messageCount,
        openReport: row.report && {
          id: row.report.id,
          reason: row.report.reason,
          createdAt: row.report.createdAt,
          byClient: row.report.reportedBy === profile.id,
        },
        canRead: row.report !== null || row.invited,
        invited: row.invited,
      }));
    });
  }

  /** The text of a conversation, for staff who may read it: it was reported, or they were invited in. */
  async staffMessages(
    actor: ProfileActor,
    chatId: string,
    after: string | undefined,
    correlationId: string,
  ): Promise<StaffMessagePage> {
    this.requireStaff(actor);
    const cursor = after ? decodeCursor(after) : null;
    if (after && !cursor) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const { conversation, a, b } = await this.staffView(unit, actor, chatId);
      const report = await unit.openReport(actor.agencyId, chatId);
      const invited = await unit.isChaperone(actor.agencyId, chatId, actor.accountId);
      if (!report && !invited) throw new AppError(403, 'CHAT_NOT_SHARED');
      if (!after) {
        await unit.logAccess(
          actor.agencyId,
          chatId,
          actor.accountId,
          report ? 'report' : 'chaperone',
        );
        await unit.appendEvent(this.event('chat.staff_read', actor, chatId, correlationId));
      }
      const rows = await unit.messages(actor.agencyId, chatId, {
        limit: CHAT_PAGE_SIZE,
        after: cursor,
      });
      const items = rows.slice(0, CHAT_PAGE_SIZE);
      const last = items.at(-1);
      return {
        chat: { id: chatId, status: conversation.status, endReason: conversation.endReason },
        people: [a, b].map((p) => ({
          profileId: p.id,
          memberCode: p.memberCode,
          fullName: p.fullName,
        })),
        items: items.map((m) => ({
          id: m.id,
          sender: m.senderProfileId,
          body: m.body,
          createdAt: m.createdAt,
        })),
        next:
          rows.length > CHAT_PAGE_SIZE && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
      };
    });
  }

  /** Staff end a conversation, and close the reports on it. */
  async staffEnd(
    actor: ProfileActor,
    chatId: string,
    note: string | undefined,
    correlationId: string,
  ) {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const { conversation } = await this.staffView(unit, actor, chatId);
      if (conversation.status !== 'ended')
        await unit.end(actor.agencyId, chatId, 'ended_by_staff', null);
      await unit.resolveReports(actor.agencyId, chatId, actor.accountId, note ?? null);
      await unit.appendEvent(this.event('chat.ended', actor, chatId, correlationId));
    });
  }

  /** Staff close the reports on a conversation without ending it. */
  async staffResolve(actor: ProfileActor, chatId: string, note: string | undefined) {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.staffView(unit, actor, chatId);
      await unit.resolveReports(actor.agencyId, chatId, actor.accountId, note ?? null);
    });
  }

  // ------------------------------------------------------------------ housekeeping

  /** Hourly: ends conversations with a profile that is no longer published and erases old messages. */
  async maintain(agencyId: string): Promise<{ ended: number; erased: number }> {
    const before = new Date(this.now().getTime() - CHAT_RETENTION_DAYS * DAY_MS);
    return this.db.inTransaction(agencyId, async (unit) => ({
      ended: await unit.endUnavailable(agencyId),
      erased: await unit.eraseOld(agencyId, before),
    }));
  }

  /** When an account is erased, its conversations end and their messages go at once. */
  async eraseFor(agencyId: string, accountId: string): Promise<void> {
    await this.db.inTransaction(agencyId, async (unit) => {
      await unit.eraseOfAccount(agencyId, accountId);
    });
  }

  // ------------------------------------------------------------------ helpers

  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private requireStaff(actor: ProfileActor) {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private async mine(unit: ChatUnit, actor: ProfileActor): Promise<ChatProfile> {
    const own = await unit.ownProfile(actor.agencyId, actor.accountId);
    if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return own;
  }

  /** The conversation, if this profile is one of its two people. Anything else is "not found". */
  private async participantIn(
    unit: ChatUnit,
    actor: ProfileActor,
    own: ChatProfile,
    chatId: string,
    lock: boolean,
  ): Promise<ConversationRow> {
    const conversation = await unit.byId(actor.agencyId, chatId, lock);
    if (!conversation || (conversation.profileA !== own.id && conversation.profileB !== own.id))
      throw new AppError(404, 'CHAT_NOT_FOUND');
    return conversation;
  }

  /** The profile a staff member may work on, or "not found". */
  private async managed(unit: ChatUnit, actor: ProfileActor, profileId: string) {
    const profile = await unit.profileById(actor.agencyId, profileId);
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  /** A conversation for staff who look after at least one of its two people (an admin: any). */
  private async staffView(unit: ChatUnit, actor: ProfileActor, chatId: string) {
    const conversation = await unit.byId(actor.agencyId, chatId, false);
    if (!conversation) throw new AppError(404, 'CHAT_NOT_FOUND');
    const a = (await unit.profileById(actor.agencyId, conversation.profileA))!;
    const b = (await unit.profileById(actor.agencyId, conversation.profileB))!;
    const actorLite = { accountId: actor.accountId, role: actor.role };
    const invited = await unit.isChaperone(actor.agencyId, chatId, actor.accountId);
    if (!canManage(actorLite, a) && !canManage(actorLite, b) && !invited)
      throw new AppError(404, 'CHAT_NOT_FOUND');
    return { conversation, a, b };
  }

  /** Whether the reader may see the other person's name: staff let them see names unless they chose otherwise. */
  private async showNames(unit: ChatUnit, agencyId: string, profileId: string) {
    const fields = (await unit.visibleFields(agencyId, profileId)) ?? DEFAULT_VISIBLE_FIELDS;
    return fields.includes('fullName');
  }

  private async summaryOf(unit: ChatUnit, actor: ProfileActor, own: ChatProfile, chatId: string) {
    const enabled = await unit.chatEnabled(actor.agencyId);
    const showNames = await this.showNames(unit, actor.agencyId, own.id);
    const listed = (await unit.listFor(actor.agencyId, own.id)).find((row) => row.id === chatId)!;
    return this.summary(unit, actor, own, listed, enabled, showNames);
  }

  private async summary(
    unit: ChatUnit,
    actor: ProfileActor,
    own: ChatProfile,
    row: ListedConversation,
    enabled: boolean,
    showNames: boolean,
  ): Promise<ChatSummary> {
    const chaperones = await unit.chaperones(actor.agencyId, row.id);
    return {
      id: row.id,
      status: row.status,
      endReason: row.endReason,
      requestedBy: row.requestedBy === own.id ? 'me' : 'them',
      other: {
        profileId: row.other.profileId,
        memberCode: row.other.memberCode,
        fullName: showNames ? row.other.fullName : null,
      },
      requestedAt: row.requestedAt,
      acceptedAt: row.acceptedAt,
      endedAt: row.endedAt,
      lastMessageAt: row.lastMessageAt,
      unread: row.unread,
      preview: row.preview,
      canSend:
        enabled &&
        row.status === 'active' &&
        own.status === 'active' &&
        row.other.status === 'active',
      chaperones: chaperones.map((c) => ({
        accountId: c.accountId,
        name: c.name,
        invitedByMe: c.invitedBy === own.id,
      })),
    };
  }

  /** An inbox line for the owner of a profile, about a conversation with another. */
  private async tell(
    unit: ChatUnit,
    agencyId: string,
    recipient: ChatProfile,
    template: 'chat.requested' | 'chat.accepted' | 'chat.message',
    chatId: string,
    about: ChatProfile,
  ) {
    if (!recipient.ownerAccountId) return;
    await unit.notify(
      agencyId,
      recipient.ownerAccountId,
      template,
      { conversationId: chatId, forProfileId: recipient.id, aboutProfileId: about.id },
      `${template}:${chatId}:${this.newId()}`,
    );
  }

  private async tellById(
    unit: ChatUnit,
    agencyId: string,
    recipientProfileId: string,
    template: 'chat.accepted',
    chatId: string,
    about: ChatProfile,
  ) {
    const recipient = await unit.profileById(agencyId, recipientProfileId);
    if (recipient) await this.tell(unit, agencyId, recipient, template, chatId, about);
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
