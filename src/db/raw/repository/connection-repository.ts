import type {
  ConnectionRecord,
  ConnectionStatus,
  NotificationItem,
  NotificationKind,
  ProfileLite,
  ReviewParty,
  ReviewRequestRow,
  StaffConnectionRow,
} from '../../../bo/connection.js';
import { ageOn } from '../../../bo/profile.js';
import type { Cursor } from '../../../bo/review.js';
import type { Transaction } from '../../config/database.js';
import { connectionQueries } from '../query/connection.js';

type Row = Record<string, unknown>;

// The inbox line of each kind of notification: the template the frontend turns into a sentence.
const TEMPLATE_OF: Record<NotificationKind, string> = {
  connection_request: 'interest.received',
  connection_accepted: 'interest.accepted',
  connection_declined: 'interest.declined',
  connection_review: 'interest.review',
  connection_review_reminder: 'interest.review_reminder',
  connection_matched: 'interest.matched',
  connection_unavailable: 'interest.unavailable',
  review_requested: 'profile.review_requested',
  candidates_released: 'candidates.released',
  client_assigned: 'client.assigned',
};
const KIND_OF = Object.fromEntries(
  Object.entries(TEMPLATE_OF).map(([kind, template]) => [template, kind]),
) as Record<string, NotificationKind>;

const record = (row: Row): ConnectionRecord => ({
  id: row.id as string,
  fromProfileId: row.from_profile_id as string,
  toProfileId: row.to_profile_id as string,
  status: row.status as ConnectionStatus,
  fromShared: row.from_shared_contact === true,
  toShared: row.to_shared_contact === true,
});

/** Every connection write and the inbox. Each method runs inside the transaction it is given. */
export class ConnectionRepository {
  /** The profiles, locked, in a fixed order. */
  async lockProfiles(
    tx: Transaction,
    agencyId: string,
    ids: readonly string[],
  ): Promise<ProfileLite[]> {
    const result = await tx.query(connectionQueries.lockProfiles, [agencyId, [...ids]]);
    return result.rows.map((row) => ({
      id: row.id as string,
      status: row.status as string,
      serviceMode: row.service_mode as ProfileLite['serviceMode'],
      ownerId: row.owner_account_id as string | null,
      assignedAgentId: row.assigned_agent_id as string | null,
    }));
  }

  /** The profiles, not locked. */
  async readProfiles(
    tx: Transaction,
    agencyId: string,
    ids: readonly string[],
  ): Promise<ProfileLite[]> {
    const result = await tx.query(connectionQueries.readProfiles, [agencyId, [...ids]]);
    return result.rows.map((row) => ({
      id: row.id as string,
      status: row.status as string,
      serviceMode: row.service_mode as ProfileLite['serviceMode'],
      ownerId: row.owner_account_id as string | null,
      assignedAgentId: row.assigned_agent_id as string | null,
    }));
  }

  async released(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    candidateId: string,
  ): Promise<boolean> {
    const result = await tx.query(connectionQueries.released, [agencyId, clientId, candidateId]);
    return result.rows.length > 0;
  }

  async pair(
    tx: Transaction,
    agencyId: string,
    a: string,
    b: string,
  ): Promise<ConnectionRecord | null> {
    const result = await tx.query(connectionQueries.pair, [agencyId, a, b]);
    return result.rows[0] ? record(result.rows[0] as Row) : null;
  }

  /** The connection. Its two profiles are locked by the caller first, which is what serialises changes to it. */
  async byId(tx: Transaction, agencyId: string, id: string): Promise<ConnectionRecord | null> {
    const result = await tx.query(connectionQueries.byId, [agencyId, id]);
    return result.rows[0] ? record(result.rows[0] as Row) : null;
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    fromId: string,
    toId: string,
    accountId: string,
    status: 'in_review' | 'pending',
    note: string | null,
  ): Promise<string> {
    const result = await tx.query(connectionQueries.insert, [
      agencyId,
      fromId,
      toId,
      accountId,
      status,
      note,
    ]);
    return (result.rows[0] as { id: string }).id;
  }

  async repend(
    tx: Transaction,
    agencyId: string,
    id: string,
    fromId: string,
    toId: string,
    accountId: string,
    status: 'in_review' | 'pending',
    note: string | null,
  ): Promise<boolean> {
    const result = await tx.query(connectionQueries.repend, [
      agencyId,
      id,
      fromId,
      toId,
      accountId,
      status,
      note,
    ]);
    return result.rows.length > 0;
  }

  /** Approves (true) or rejects (false) a request waiting for review. False when it no longer waits. */
  async reviewDecide(
    tx: Transaction,
    agencyId: string,
    id: string,
    approve: boolean,
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(connectionQueries.reviewDecide, [
      agencyId,
      id,
      approve,
      accountId,
    ]);
    return result.rows.length > 0;
  }

  /** A declined pair becomes one that can be asked again. */
  async reopen(tx: Transaction, agencyId: string, id: string): Promise<boolean> {
    const result = await tx.query(connectionQueries.reopen, [agencyId, id]);
    return result.rows.length > 0;
  }

  async admins(tx: Transaction, agencyId: string): Promise<string[]> {
    const result = await tx.query(connectionQueries.admins, [agencyId]);
    return result.rows.map((row) => row.id as string);
  }

  /** One page of requests waiting for review, longest-waiting first. Asks for one more than `limit`. */
  async reviewQueue(
    tx: Transaction,
    agencyId: string,
    reader: { accountId: string; isAdmin: boolean },
    page: { limit: number; after: Cursor | null },
    today: Date,
  ): Promise<ReviewRequestRow[]> {
    const result = await tx.query(connectionQueries.reviewQueue, [
      agencyId,
      reader.isAdmin,
      reader.accountId,
      page.after?.createdAt ?? null,
      page.after?.id ?? null,
      page.limit + 1,
    ]);
    const party = (row: Row, side: 'from' | 'to'): ReviewParty => {
      const born = row[`${side}_dob`] as string | null;
      return {
        profileId: row[`${side}_id`] as string,
        memberCode: row[`${side}_code`] as string,
        fullName: row[`${side}_name`] as string,
        age: born ? ageOn(born, today) : null,
        professionCode: row[`${side}_profession`] as string | null,
        currentDistrictCode: row[`${side}_district`] as string | null,
      };
    };
    return result.rows.map((row) => ({
      connectionId: row.connection_id as string,
      createdAt: (row.created_at as Date).toISOString(),
      waitingSince: (row.review_started_at as Date).toISOString(),
      remindersSent: row.reminders_sent as number,
      note: (row.note as string | null) ?? null,
      position: row.position as string,
      asker: party(row, 'from'),
      client: party(row, 'to'),
    }));
  }

  async reviewCount(
    tx: Transaction,
    agencyId: string,
    reader: { accountId: string; isAdmin: boolean },
  ): Promise<number> {
    const result = await tx.query(connectionQueries.reviewCount, [
      agencyId,
      reader.isAdmin,
      reader.accountId,
    ]);
    return (result.rows[0]?.total as number | undefined) ?? 0;
  }

  /** Requests whose next reminder is due, locked for this transaction. */
  async dueReminders(
    tx: Transaction,
    agencyId: string,
    now: Date,
    firstAfterSeconds: number,
    thenAfterSeconds: number,
    limit: number,
  ) {
    const result = await tx.query(connectionQueries.dueReminders, [
      agencyId,
      now,
      firstAfterSeconds,
      thenAfterSeconds,
      limit,
    ]);
    return result.rows.map((row) => ({
      id: row.id as string,
      fromProfileId: row.from_profile_id as string,
      toProfileId: row.to_profile_id as string,
      assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
      remindersSent: row.reminders_sent as number,
    }));
  }

  async markReminded(tx: Transaction, agencyId: string, id: string, now: Date): Promise<void> {
    await tx.query(connectionQueries.markReminded, [agencyId, id, now]);
  }

  async respond(
    tx: Transaction,
    agencyId: string,
    id: string,
    status: 'accepted' | 'declined',
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(connectionQueries.respond, [agencyId, id, status, accountId]);
    return result.rows.length > 0;
  }

  async withdraw(tx: Transaction, agencyId: string, id: string, fromId: string): Promise<boolean> {
    const result = await tx.query(connectionQueries.withdraw, [agencyId, id, fromId]);
    return result.rows.length > 0;
  }

  /** Marks the given side of an accepted connection as having shared its contact details. */
  async share(
    tx: Transaction,
    agencyId: string,
    id: string,
    profileId: string,
    side: 'from' | 'to',
  ): Promise<boolean> {
    const sql = side === 'from' ? connectionQueries.shareFrom : connectionQueries.shareTo;
    const result = await tx.query(sql, [agencyId, id, profileId]);
    return result.rows.length > 0;
  }

  async notify(
    tx: Transaction,
    agencyId: string,
    recipientId: string,
    kind: NotificationKind,
    connectionId: string,
    forProfileId: string,
    aboutProfileId: string,
    eventKey: string,
  ): Promise<void> {
    await tx.query(connectionQueries.notify, [
      agencyId,
      recipientId,
      eventKey,
      TEMPLATE_OF[kind],
      JSON.stringify({ interestId: connectionId, forProfileId, aboutProfileId }),
    ]);
  }

  /** How many lines of the inbox this account has not read. */
  async unreadCount(tx: Transaction, agencyId: string, accountId: string): Promise<number> {
    const result = await tx.query(connectionQueries.unreadCount, [agencyId, accountId]);
    return (result.rows[0]?.unread as number | undefined) ?? 0;
  }

  /** Marks the given lines, or every line when `ids` is null, as read. Returns how many changed. */
  async markRead(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    ids: readonly string[] | null,
  ): Promise<number> {
    const result = await tx.query(connectionQueries.markRead, [
      agencyId,
      accountId,
      ids ? [...ids] : null,
    ]);
    return result.rows.length;
  }

  /** One page of an account's inbox, newest first. Asks for one more than `limit`. */
  async notifications(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    showNames: boolean,
    page: { limit: number; after: Cursor | null },
  ): Promise<NotificationItem[]> {
    const result = await tx.query(connectionQueries.notifications, [
      agencyId,
      accountId,
      page.after?.createdAt ?? null,
      page.after?.id ?? null,
      page.limit + 1,
      showNames,
    ]);
    return result.rows.map((row) => ({
      id: row.id as string,
      kind: KIND_OF[row.template_key as string]!,
      createdAt: (row.created_at as Date).toISOString(),
      position: row.position as string,
      read: row.is_read === true,
      connectionId: (row.payload as { interestId?: string }).interestId ?? null,
      what: (row.payload as { what?: string }).what ?? null,
      count: (row.payload as { count?: number }).count ?? null,
      forProfileId: (row.payload as { forProfileId: string }).forProfileId,
      about: {
        profileId: row.about_profile_id as string,
        memberCode: row.member_code as string,
        fullName: (row.full_name as string | null) ?? null,
      },
    }));
  }

  /** A client's connections as staff see them. */
  async staffList(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    today: Date,
  ): Promise<StaffConnectionRow[]> {
    const result = await tx.query(connectionQueries.staffList, [agencyId, clientId]);
    return result.rows.map((row) => {
      const sent = row.sent === true;
      const born = row.date_of_birth as string | null;
      return {
        connectionId: row.connection_id as string,
        status: row.status as ConnectionStatus,
        direction: sent ? 'sent' : 'received',
        createdAt: (row.created_at as Date).toISOString(),
        respondedAt: row.responded_at ? (row.responded_at as Date).toISOString() : null,
        clientShared: (sent ? row.from_shared_contact : row.to_shared_contact) === true,
        otherShared: (sent ? row.to_shared_contact : row.from_shared_contact) === true,
        other: {
          profileId: row.id as string,
          memberCode: row.member_code as string,
          fullName: row.full_name as string,
          age: born ? ageOn(born, today) : null,
          professionCode: row.profession_code as string | null,
          currentDistrictCode: row.current_district_code as string | null,
          serviceMode: row.service_mode as StaffConnectionRow['other']['serviceMode'],
        },
      };
    });
  }
}
