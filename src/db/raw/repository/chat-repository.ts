import type { ChatEndReason, ChatStatus } from '../../../bo/chat.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

const POSITION = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const num = (value: unknown) => Number(value ?? 0);
const iso = (value: unknown) => (value ? (value as Date).toISOString() : null);

export interface ChatProfile {
  id: string;
  memberCode: string;
  fullName: string;
  status: string;
  ownerAccountId: string | null;
  assignedAgentId: string | null;
}

export interface ConversationRow {
  id: string;
  interestId: string;
  profileA: string;
  profileB: string;
  requestedBy: string;
  status: ChatStatus;
  endReason: ChatEndReason | null;
  requestedAt: string;
  acceptedAt: string | null;
  endedAt: string | null;
  lastMessageAt: string | null;
}

export interface ListedConversation extends ConversationRow {
  other: { profileId: string; memberCode: string; fullName: string; status: string };
  unread: number;
  preview: string | null;
}

export interface StoredMessage {
  id: string;
  senderProfileId: string;
  body: string;
  masked: boolean;
  createdAt: string;
  read: boolean;
  position: string;
}

const profile = (row: Row | undefined): ChatProfile | null =>
  row
    ? {
        id: row.id as string,
        memberCode: row.member_code as string,
        fullName: row.full_name as string,
        status: row.status as string,
        ownerAccountId: (row.owner_account_id as string | null) ?? null,
        assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
      }
    : null;

const conversation = (row: Row): ConversationRow => ({
  id: row.id as string,
  interestId: row.interest_id as string,
  profileA: row.profile_a as string,
  profileB: row.profile_b as string,
  requestedBy: row.requested_by as string,
  status: row.status as ChatStatus,
  endReason: (row.end_reason as ChatEndReason | null) ?? null,
  requestedAt: iso(row.requested_at)!,
  acceptedAt: iso(row.accepted_at),
  endedAt: iso(row.ended_at),
  lastMessageAt: iso(row.last_message_at),
});

const CONVERSATION = `c.id, c.interest_id, c.profile_a, c.profile_b, c.requested_by, c.status, c.end_reason,
       c.requested_at, c.accepted_at, c.ended_at, c.last_message_at`;
const PROFILE = `id, member_code, full_name, status, owner_account_id, assigned_agent_id`;

/** Conversations between two clients: who may talk, what was said, and what staff may see. */
export class ChatRepository {
  async chatEnabled(tx: Transaction, agencyId: string) {
    const result = await tx.query('SELECT chat_enabled FROM matrimony.agencies WHERE id = $1', [
      agencyId,
    ]);
    return (result.rows[0] as Row | undefined)?.chat_enabled === true;
  }

  async ownProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT ${PROFILE} FROM matrimony.member_profiles WHERE agency_id = $1 AND owner_account_id = $2`,
      [agencyId, accountId],
    );
    return profile(result.rows[0] as Row | undefined);
  }

  async profileById(tx: Transaction, agencyId: string, id: string) {
    const result = await tx.query(
      `SELECT ${PROFILE} FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
    return profile(result.rows[0] as Row | undefined);
  }

  /** The visible fields staff chose for a member, null when none were set. */
  async visibleFields(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT visible_fields FROM matrimony.client_release_settings
        WHERE agency_id = $1 AND client_profile_id = $2`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? (row.visible_fields as string[]) : null;
  }

  async interest(tx: Transaction, agencyId: string, id: string) {
    const result = await tx.query(
      `SELECT id, status, sender_profile_id, recipient_profile_id FROM matrimony.interests
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          status: row.status as string,
          senderProfileId: row.sender_profile_id as string,
          recipientProfileId: row.recipient_profile_id as string,
        }
      : null;
  }

  async byInterest(tx: Transaction, agencyId: string, interestId: string) {
    const result = await tx.query(
      `SELECT ${CONVERSATION} FROM matrimony.chat_conversations c
        WHERE c.agency_id = $1 AND c.interest_id = $2 FOR UPDATE`,
      [agencyId, interestId],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? conversation(row) : null;
  }

  async byId(tx: Transaction, agencyId: string, id: string, lock = false) {
    const result = await tx.query(
      `SELECT ${CONVERSATION} FROM matrimony.chat_conversations c
        WHERE c.agency_id = $1 AND c.id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [agencyId, id],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? conversation(row) : null;
  }

  async insertConversation(
    tx: Transaction,
    agencyId: string,
    input: {
      id: string;
      interestId: string;
      profileA: string;
      profileB: string;
      requestedBy: string;
    },
  ) {
    await tx.query(
      `INSERT INTO matrimony.chat_conversations (agency_id, id, interest_id, profile_a, profile_b, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agencyId, input.id, input.interestId, input.profileA, input.profileB, input.requestedBy],
    );
  }

  /** A declined or ended conversation is asked for again: it starts from "requested". */
  async reopen(tx: Transaction, agencyId: string, id: string, requestedBy: string) {
    await tx.query(
      `UPDATE matrimony.chat_conversations
          SET status = 'requested', end_reason = NULL, ended_by = NULL, ended_at = NULL,
              requested_by = $3, requested_at = now(), accepted_at = NULL
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, requestedBy],
    );
  }

  async activate(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.chat_conversations SET status = 'active', accepted_at = now()
        WHERE agency_id = $1 AND id = $2 AND status = 'requested'`,
      [agencyId, id],
    );
  }

  async end(
    tx: Transaction,
    agencyId: string,
    id: string,
    reason: ChatEndReason,
    byProfile: string | null,
  ) {
    await tx.query(
      `UPDATE matrimony.chat_conversations
          SET status = 'ended', end_reason = $3, ended_by = $4, ended_at = now()
        WHERE agency_id = $1 AND id = $2 AND status <> 'ended'`,
      [agencyId, id, reason, byProfile],
    );
  }

  async listFor(
    tx: Transaction,
    agencyId: string,
    profileId: string,
  ): Promise<ListedConversation[]> {
    const result = await tx.query(
      `SELECT ${CONVERSATION},
              o.id AS o_id, o.member_code AS o_code, o.full_name AS o_name, o.status AS o_status,
              (SELECT count(*) FROM matrimony.chat_messages m
                WHERE m.agency_id = c.agency_id AND m.conversation_id = c.id
                  AND m.sender_profile_id <> $2 AND m.read_at IS NULL)::int AS unread,
              (SELECT m.body FROM matrimony.chat_messages m
                WHERE m.agency_id = c.agency_id AND m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS preview
         FROM matrimony.chat_conversations c
         JOIN matrimony.member_profiles o ON o.agency_id = c.agency_id
          AND o.id = CASE WHEN c.profile_a = $2 THEN c.profile_b ELSE c.profile_a END
        WHERE c.agency_id = $1 AND (c.profile_a = $2 OR c.profile_b = $2)
        ORDER BY coalesce(c.last_message_at, c.requested_at) DESC, c.id`,
      [agencyId, profileId],
    );
    return (result.rows as Row[]).map((row) => ({
      ...conversation(row),
      other: {
        profileId: row.o_id as string,
        memberCode: row.o_code as string,
        fullName: row.o_name as string,
        status: row.o_status as string,
      },
      unread: num(row.unread),
      preview: (row.preview as string | null) ?? null,
    }));
  }

  async messages(
    tx: Transaction,
    agencyId: string,
    conversationId: string,
    page: { limit: number; after: { createdAt: string; id: string } | null },
  ): Promise<StoredMessage[]> {
    const result = await tx.query(
      `SELECT id, sender_profile_id, body, masked, created_at, read_at IS NOT NULL AS is_read,
              ${POSITION('created_at')} AS position
         FROM matrimony.chat_messages
        WHERE agency_id = $1 AND conversation_id = $2
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [
        agencyId,
        conversationId,
        page.after?.createdAt ?? null,
        page.after?.id ?? null,
        page.limit + 1,
      ],
    );
    return (result.rows as Row[]).map((row) => ({
      id: row.id as string,
      senderProfileId: row.sender_profile_id as string,
      body: row.body as string,
      masked: row.masked === true,
      createdAt: iso(row.created_at)!,
      read: row.is_read === true,
      position: row.position as string,
    }));
  }

  async messageCount(tx: Transaction, agencyId: string, conversationId: string) {
    const result = await tx.query(
      'SELECT count(*)::int AS n FROM matrimony.chat_messages WHERE agency_id = $1 AND conversation_id = $2',
      [agencyId, conversationId],
    );
    return num((result.rows[0] as Row).n);
  }

  async unreadFrom(tx: Transaction, agencyId: string, conversationId: string, sender: string) {
    const result = await tx.query(
      `SELECT count(*)::int AS n FROM matrimony.chat_messages
        WHERE agency_id = $1 AND conversation_id = $2 AND sender_profile_id = $3 AND read_at IS NULL`,
      [agencyId, conversationId, sender],
    );
    return num((result.rows[0] as Row).n);
  }

  async insertMessage(
    tx: Transaction,
    agencyId: string,
    input: { id: string; conversationId: string; sender: string; body: string; masked: boolean },
  ) {
    await tx.query(
      `INSERT INTO matrimony.chat_messages (agency_id, id, conversation_id, sender_profile_id, body, masked)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agencyId, input.id, input.conversationId, input.sender, input.body, input.masked],
    );
    await tx.query(
      `UPDATE matrimony.chat_conversations SET last_message_at = now()
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, input.conversationId],
    );
  }

  /** Marks what the other person wrote as read by this reader. */
  async markRead(tx: Transaction, agencyId: string, conversationId: string, reader: string) {
    await tx.query(
      `UPDATE matrimony.chat_messages SET read_at = now()
        WHERE agency_id = $1 AND conversation_id = $2 AND sender_profile_id <> $3 AND read_at IS NULL`,
      [agencyId, conversationId, reader],
    );
  }

  async insertReport(
    tx: Transaction,
    agencyId: string,
    input: { id: string; conversationId: string; reportedBy: string; reason: string },
  ) {
    await tx.query(
      `INSERT INTO matrimony.chat_reports (agency_id, id, conversation_id, reported_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [agencyId, input.id, input.conversationId, input.reportedBy, input.reason],
    );
  }

  async openReport(tx: Transaction, agencyId: string, conversationId: string) {
    const result = await tx.query(
      `SELECT r.id, r.reason, r.created_at, r.reported_by FROM matrimony.chat_reports r
        WHERE r.agency_id = $1 AND r.conversation_id = $2 AND r.resolved_at IS NULL
        ORDER BY r.created_at DESC LIMIT 1`,
      [agencyId, conversationId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          reason: row.reason as string,
          createdAt: iso(row.created_at)!,
          reportedBy: row.reported_by as string,
        }
      : null;
  }

  async resolveReports(
    tx: Transaction,
    agencyId: string,
    conversationId: string,
    by: string,
    note: string | null,
  ) {
    const result = await tx.query(
      `UPDATE matrimony.chat_reports SET resolved_at = now(), resolved_by = $3, resolution_note = $4
        WHERE agency_id = $1 AND conversation_id = $2 AND resolved_at IS NULL RETURNING id`,
      [agencyId, conversationId, by, note],
    );
    return result.rows.length;
  }

  async logAccess(
    tx: Transaction,
    agencyId: string,
    conversationId: string,
    staff: string,
    basis: 'report',
  ) {
    await tx.query(
      `INSERT INTO matrimony.chat_access_log (agency_id, conversation_id, staff_account_id, basis)
       VALUES ($1, $2, $3, $4)`,
      [agencyId, conversationId, staff, basis],
    );
  }

  /** A client's conversations for staff: that they exist, with counts, never the text. */
  async staffList(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT ${CONVERSATION},
              o.id AS o_id, o.member_code AS o_code, o.full_name AS o_name,
              (SELECT count(*) FROM matrimony.chat_messages m
                WHERE m.agency_id = c.agency_id AND m.conversation_id = c.id)::int AS messages,
              r.id AS report_id, r.reason AS report_reason, r.created_at AS report_at, r.reported_by
         FROM matrimony.chat_conversations c
         JOIN matrimony.member_profiles o ON o.agency_id = c.agency_id
          AND o.id = CASE WHEN c.profile_a = $2 THEN c.profile_b ELSE c.profile_a END
         LEFT JOIN LATERAL (
           SELECT x.id, x.reason, x.created_at, x.reported_by FROM matrimony.chat_reports x
            WHERE x.agency_id = c.agency_id AND x.conversation_id = c.id AND x.resolved_at IS NULL
            ORDER BY x.created_at DESC LIMIT 1) r ON true
        WHERE c.agency_id = $1 AND (c.profile_a = $2 OR c.profile_b = $2)
        ORDER BY coalesce(c.last_message_at, c.requested_at) DESC, c.id`,
      [agencyId, profileId],
    );
    return (result.rows as Row[]).map((row) => ({
      ...conversation(row),
      other: {
        profileId: row.o_id as string,
        memberCode: row.o_code as string,
        fullName: row.o_name as string,
      },
      messageCount: num(row.messages),
      report: row.report_id
        ? {
            id: row.report_id as string,
            reason: row.report_reason as string,
            createdAt: iso(row.report_at)!,
            reportedBy: row.reported_by as string,
          }
        : null,
    }));
  }

  /** Accounts told about a report: every admin and the agent of each of the two clients. */
  async reportRecipients(tx: Transaction, agencyId: string, a: string, b: string) {
    const result = await tx.query(
      `SELECT DISTINCT id FROM (
         SELECT id FROM matrimony.accounts WHERE agency_id = $1 AND role = 'admin' AND status = 'active'
         UNION ALL
         SELECT assigned_agent_id FROM matrimony.member_profiles
          WHERE agency_id = $1 AND id IN ($2, $3) AND assigned_agent_id IS NOT NULL
       ) x(id)`,
      [agencyId, a, b],
    );
    return (result.rows as Row[]).map((row) => row.id as string);
  }

  /** One line in an account's inbox about a conversation. */
  async notify(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    template: string,
    payload: { conversationId: string; forProfileId: string; aboutProfileId: string },
    key: string,
  ) {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (agency_id, recipient_account_id, event_key) DO NOTHING`,
      [agencyId, accountId, key, template, JSON.stringify(payload)],
    );
  }

  /** Housekeeping, run by the hourly job (see migration 032). */
  async endUnavailable(tx: Transaction, agencyId: string) {
    const result = await tx.query('SELECT matrimony.end_unavailable_chats($1) AS n', [agencyId]);
    return num((result.rows[0] as Row).n);
  }

  async eraseOld(tx: Transaction, agencyId: string, before: Date) {
    const result = await tx.query('SELECT matrimony.erase_old_chat_messages($1, $2) AS n', [
      agencyId,
      before.toISOString(),
    ]);
    return num((result.rows[0] as Row).n);
  }

  async eraseOfAccount(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query('SELECT matrimony.erase_chats_of_account($1, $2) AS n', [
      agencyId,
      accountId,
    ]);
    return num((result.rows[0] as Row).n);
  }
}
