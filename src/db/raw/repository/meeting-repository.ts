import type {
  FeedbackInput,
  FollowUpRow,
  MeetingFeedback,
  MeetingKind,
  MeetingStatus,
  NoteRow,
  Verdict,
} from '../../../bo/meeting.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

export interface MeetingProfile {
  id: string;
  memberCode: string;
  fullName: string;
  assignedAgentId: string | null;
  ownerAccountId: string | null;
}

export interface InterestSides {
  id: string;
  status: string;
  senderId: string;
  recipientId: string;
}

/** A meeting row with both sides, before the staff view decides what each person may see. */
export interface RawMeeting {
  id: string;
  connectionId: string;
  scheduledAt: string;
  kind: MeetingKind;
  place: string | null;
  note: string | null;
  status: MeetingStatus;
  createdBy: string;
  past: boolean;
  sides: [RawSide, RawSide];
}

export interface RawSide {
  profileId: string;
  memberCode: string;
  fullName: string;
  agentId: string | null;
  ownerId: string | null;
}

const PROFILE_COLUMNS = `id, member_code, full_name, assigned_agent_id, owner_account_id`;
const profileOf = (row: Row | undefined): MeetingProfile | null =>
  row
    ? {
        id: row.id as string,
        memberCode: row.member_code as string,
        fullName: row.full_name as string,
        assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
        ownerAccountId: (row.owner_account_id as string | null) ?? null,
      }
    : null;

const MEETING_SELECT = `m.id, m.interest_id, m.scheduled_at, m.kind, m.place, m.note, m.status,
       (m.scheduled_at < now()) AS past, ca.display_name AS created_by_name,
       s.id AS s_id, s.member_code AS s_code, s.full_name AS s_name,
       s.assigned_agent_id AS s_agent, s.owner_account_id AS s_owner,
       r.id AS r_id, r.member_code AS r_code, r.full_name AS r_name,
       r.assigned_agent_id AS r_agent, r.owner_account_id AS r_owner
  FROM matrimony.meetings m
  JOIN matrimony.interests i ON i.agency_id = m.agency_id AND i.id = m.interest_id
  JOIN matrimony.member_profiles s ON s.agency_id = i.agency_id AND s.id = i.sender_profile_id
  JOIN matrimony.member_profiles r ON r.agency_id = i.agency_id AND r.id = i.recipient_profile_id
  JOIN matrimony.accounts ca ON ca.agency_id = m.agency_id AND ca.id = m.created_by`;

const side = (row: Row, p: 's' | 'r'): RawSide => ({
  profileId: row[`${p}_id`] as string,
  memberCode: row[`${p}_code`] as string,
  fullName: row[`${p}_name`] as string,
  agentId: (row[`${p}_agent`] as string | null) ?? null,
  ownerId: (row[`${p}_owner`] as string | null) ?? null,
});

const meetingOf = (row: Row): RawMeeting => ({
  id: row.id as string,
  connectionId: row.interest_id as string,
  scheduledAt: (row.scheduled_at as Date).toISOString(),
  kind: row.kind as MeetingKind,
  place: (row.place as string | null) ?? null,
  note: (row.note as string | null) ?? null,
  status: row.status as MeetingStatus,
  createdBy: row.created_by_name as string,
  past: row.past === true,
  sides: [side(row, 's'), side(row, 'r')],
});

const followUpOf = (row: Row): FollowUpRow => ({
  id: row.id as string,
  profile: {
    id: row.profile_id as string,
    memberCode: row.member_code as string,
    fullName: row.full_name as string,
  },
  dueOn: row.due_on as string,
  text: row.text as string,
  assignedTo: row.assigned_name as string,
  due: row.due === true,
  done: row.done_at
    ? { at: (row.done_at as Date).toISOString(), by: row.done_by_name as string }
    : null,
});

const FOLLOW_UP_SELECT = `f.id, f.profile_id, p.member_code, p.full_name, to_char(f.due_on, 'YYYY-MM-DD') AS due_on,
       f.text, f.done_at, aa.display_name AS assigned_name, da.display_name AS done_by_name,
       (f.done_at IS NULL AND f.due_on <= (now() AT TIME ZONE 'Asia/Dhaka')::date) AS due
  FROM matrimony.client_follow_ups f
  JOIN matrimony.member_profiles p ON p.agency_id = f.agency_id AND p.id = f.profile_id
  JOIN matrimony.accounts aa ON aa.agency_id = f.agency_id AND aa.id = f.assigned_to
  LEFT JOIN matrimony.accounts da ON da.agency_id = f.agency_id AND da.id = f.done_by`;

/** Meetings, feedback, notes and follow-ups. Never deletes a row. */
export class MeetingRepository {
  async profileById(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT ${PROFILE_COLUMNS} FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    return profileOf(result.rows[0]);
  }

  async ownProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT ${PROFILE_COLUMNS} FROM matrimony.member_profiles
        WHERE agency_id = $1 AND owner_account_id = $2`,
      [agencyId, accountId],
    );
    return profileOf(result.rows[0]);
  }

  /** The profile a guardian account looks after, while the guardian link is active. */
  async guardedProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT p.id, p.member_code, p.full_name, p.assigned_agent_id, p.owner_account_id
         FROM matrimony.profile_guardians g
         JOIN matrimony.member_profiles p ON p.agency_id = g.agency_id AND p.id = g.profile_id
        WHERE g.agency_id = $1 AND g.account_id = $2 AND g.status = 'active'`,
      [agencyId, accountId],
    );
    return profileOf(result.rows[0]);
  }

  async interest(tx: Transaction, agencyId: string, interestId: string) {
    const result = await tx.query(
      `SELECT id, status, sender_profile_id, recipient_profile_id
         FROM matrimony.interests WHERE agency_id = $1 AND id = $2`,
      [agencyId, interestId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? ({
          id: row.id,
          status: row.status,
          senderId: row.sender_profile_id,
          recipientId: row.recipient_profile_id,
        } as InterestSides)
      : null;
  }

  async insertMeeting(
    tx: Transaction,
    agencyId: string,
    m: {
      id: string;
      interestId: string;
      scheduledAt: string;
      kind: MeetingKind;
      place: string | null;
      note: string | null;
      createdBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.meetings (agency_id, id, interest_id, scheduled_at, kind, place, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [agencyId, m.id, m.interestId, m.scheduledAt, m.kind, m.place, m.note, m.createdBy],
    );
  }

  async meeting(tx: Transaction, agencyId: string, id: string): Promise<RawMeeting | null> {
    const result = await tx.query(`SELECT ${MEETING_SELECT} WHERE m.agency_id = $1 AND m.id = $2`, [
      agencyId,
      id,
    ]);
    return result.rows[0] ? meetingOf(result.rows[0]) : null;
  }

  /** Changes a meeting that is still scheduled. False when it is not any more. */
  async updateMeeting(
    tx: Transaction,
    agencyId: string,
    id: string,
    patch: {
      scheduledAt?: string;
      kind?: MeetingKind;
      place?: string | null;
      note?: string | null;
      status?: 'done' | 'cancelled';
    },
  ): Promise<boolean> {
    const has = (key: keyof typeof patch) => patch[key] !== undefined;
    const result = await tx.query(
      `UPDATE matrimony.meetings SET
          scheduled_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE scheduled_at END,
          kind = CASE WHEN $5::boolean THEN $6::text ELSE kind END,
          place = CASE WHEN $7::boolean THEN $8::text ELSE place END,
          note = CASE WHEN $9::boolean THEN $10::text ELSE note END,
          status = CASE WHEN $11::boolean THEN $12::text ELSE status END,
          updated_at = now()
        WHERE agency_id = $1 AND id = $2 AND status = 'scheduled'`,
      [
        agencyId,
        id,
        has('scheduledAt'),
        patch.scheduledAt ?? null,
        has('kind'),
        patch.kind ?? null,
        has('place'),
        patch.place ?? null,
        has('note'),
        patch.note ?? null,
        has('status'),
        patch.status ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  /** Meetings of a proposal side, newest first. */
  async meetingsOfProfile(
    tx: Transaction,
    agencyId: string,
    profileId: string,
  ): Promise<RawMeeting[]> {
    const result = await tx.query(
      `SELECT ${MEETING_SELECT}
        WHERE m.agency_id = $1 AND (i.sender_profile_id = $2 OR i.recipient_profile_id = $2)
        ORDER BY m.scheduled_at DESC LIMIT 100`,
      [agencyId, profileId],
    );
    return result.rows.map(meetingOf);
  }

  /** Scheduled meetings of the clients an agent looks after (or of everyone, for an admin). */
  async agendaMeetings(
    tx: Transaction,
    agencyId: string,
    agentId: string | null,
  ): Promise<RawMeeting[]> {
    const result = await tx.query(
      `SELECT ${MEETING_SELECT}
        WHERE m.agency_id = $1 AND m.status = 'scheduled'
          AND ($2::uuid IS NULL OR s.assigned_agent_id = $2::uuid OR r.assigned_agent_id = $2::uuid)
        ORDER BY m.scheduled_at ASC LIMIT 100`,
      [agencyId, agentId],
    );
    return result.rows.map(meetingOf);
  }

  /** The feedback recorded for some meetings, keyed `meetingId:profileId`. */
  async feedbackFor(
    tx: Transaction,
    agencyId: string,
    meetingIds: string[],
  ): Promise<Map<string, MeetingFeedback>> {
    if (meetingIds.length === 0) return new Map();
    const result = await tx.query(
      `SELECT meeting_id, profile_id, verdict, note, recorded_at
         FROM matrimony.meeting_feedback WHERE agency_id = $1 AND meeting_id = ANY($2::uuid[])`,
      [agencyId, meetingIds],
    );
    return new Map(
      result.rows.map((row: Row) => [
        `${row.meeting_id}:${row.profile_id}`,
        {
          verdict: row.verdict as Verdict,
          note: (row.note as string | null) ?? null,
          recordedAt: (row.recorded_at as Date).toISOString(),
        },
      ]),
    );
  }

  async saveFeedback(
    tx: Transaction,
    agencyId: string,
    meetingId: string,
    profileId: string,
    input: FeedbackInput,
    recordedBy: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.meeting_feedback (agency_id, meeting_id, profile_id, verdict, note, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agency_id, meeting_id, profile_id)
       DO UPDATE SET verdict = EXCLUDED.verdict, note = EXCLUDED.note,
                     recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [agencyId, meetingId, profileId, input.verdict, input.note ?? null, recordedBy],
    );
  }

  /** The meetings of a member's accepted proposals, newest first. */
  async meetingsOfMember(
    tx: Transaction,
    agencyId: string,
    profileId: string,
  ): Promise<RawMeeting[]> {
    const result = await tx.query(
      `SELECT ${MEETING_SELECT}
        WHERE m.agency_id = $1 AND i.status = 'accepted'
          AND (i.sender_profile_id = $2 OR i.recipient_profile_id = $2)
        ORDER BY m.scheduled_at DESC LIMIT 100`,
      [agencyId, profileId],
    );
    return result.rows.map(meetingOf);
  }

  async insertNote(
    tx: Transaction,
    agencyId: string,
    note: { id: string; profileId: string; body: string; authorId: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.client_notes (agency_id, id, profile_id, body, author_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [agencyId, note.id, note.profileId, note.body, note.authorId],
    );
  }

  async notes(tx: Transaction, agencyId: string, profileId: string): Promise<NoteRow[]> {
    const result = await tx.query(
      `SELECT n.id, n.body, n.created_at, a.display_name AS author
         FROM matrimony.client_notes n
         JOIN matrimony.accounts a ON a.agency_id = n.agency_id AND a.id = n.author_id
        WHERE n.agency_id = $1 AND n.profile_id = $2
        ORDER BY n.created_at DESC LIMIT 200`,
      [agencyId, profileId],
    );
    return result.rows.map((row: Row) => ({
      id: row.id as string,
      body: row.body as string,
      author: row.author as string,
      createdAt: (row.created_at as Date).toISOString(),
    }));
  }

  async insertFollowUp(
    tx: Transaction,
    agencyId: string,
    f: {
      id: string;
      profileId: string;
      dueOn: string;
      text: string;
      assignedTo: string;
      createdBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.client_follow_ups (agency_id, id, profile_id, due_on, text, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [agencyId, f.id, f.profileId, f.dueOn, f.text, f.assignedTo, f.createdBy],
    );
  }

  async followUpsOfProfile(
    tx: Transaction,
    agencyId: string,
    profileId: string,
  ): Promise<FollowUpRow[]> {
    const result = await tx.query(
      `SELECT ${FOLLOW_UP_SELECT}
        WHERE f.agency_id = $1 AND f.profile_id = $2
        ORDER BY (f.done_at IS NOT NULL), f.due_on ASC LIMIT 100`,
      [agencyId, profileId],
    );
    return result.rows.map(followUpOf);
  }

  /** Open follow-ups of one staff member, or of the whole agency for an admin (null). */
  async openFollowUps(
    tx: Transaction,
    agencyId: string,
    assignedTo: string | null,
  ): Promise<FollowUpRow[]> {
    const result = await tx.query(
      `SELECT ${FOLLOW_UP_SELECT}
        WHERE f.agency_id = $1 AND f.done_at IS NULL
          AND ($2::uuid IS NULL OR f.assigned_to = $2::uuid)
        ORDER BY f.due_on ASC LIMIT 200`,
      [agencyId, assignedTo],
    );
    return result.rows.map(followUpOf);
  }

  async followUp(tx: Transaction, agencyId: string, id: string) {
    const result = await tx.query(
      `SELECT f.profile_id, f.assigned_to, f.done_at FROM matrimony.client_follow_ups f
        WHERE f.agency_id = $1 AND f.id = $2`,
      [agencyId, id],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          profileId: row.profile_id as string,
          assignedTo: row.assigned_to as string,
          done: row.done_at !== null,
        }
      : null;
  }

  async markFollowUpDone(
    tx: Transaction,
    agencyId: string,
    id: string,
    doneBy: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.client_follow_ups SET done_at = now(), done_by = $3
        WHERE agency_id = $1 AND id = $2 AND done_at IS NULL`,
      [agencyId, id, doneBy],
    );
    return result.rowCount === 1;
  }

  /**
   * Tells the people a meeting is about, when it is set or changed: both clients who sign in, and
   * the staff who look after either side, but never the person who made the change.
   */
  async notifyMeeting(
    tx: Transaction,
    agencyId: string,
    meetingId: string,
    interestId: string,
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       SELECT $1, w.account_id, 'meeting:' || $2::text || ':' || gen_random_uuid()::text, 'meeting.update',
              jsonb_build_object('interestId', $3::uuid, 'forProfileId', w.for_profile, 'aboutProfileId', w.about_profile)
         FROM (
           SELECT p.owner_account_id AS account_id, p.id AS for_profile, o.id AS about_profile
             FROM matrimony.interests i
             JOIN matrimony.member_profiles p ON p.agency_id = i.agency_id AND p.id IN (i.sender_profile_id, i.recipient_profile_id)
             JOIN matrimony.member_profiles o ON o.agency_id = i.agency_id AND o.id IN (i.sender_profile_id, i.recipient_profile_id) AND o.id <> p.id
            WHERE i.agency_id = $1 AND i.id = $3 AND p.owner_account_id IS NOT NULL
           UNION
           SELECT g.account_id, p.id, o.id
             FROM matrimony.interests i
             JOIN matrimony.member_profiles p ON p.agency_id = i.agency_id AND p.id IN (i.sender_profile_id, i.recipient_profile_id)
             JOIN matrimony.member_profiles o ON o.agency_id = i.agency_id AND o.id IN (i.sender_profile_id, i.recipient_profile_id) AND o.id <> p.id
             JOIN matrimony.profile_guardians g ON g.agency_id = p.agency_id AND g.profile_id = p.id AND g.status = 'active'
            WHERE i.agency_id = $1 AND i.id = $3
           UNION
           SELECT p.assigned_agent_id, p.id, o.id
             FROM matrimony.interests i
             JOIN matrimony.member_profiles p ON p.agency_id = i.agency_id AND p.id IN (i.sender_profile_id, i.recipient_profile_id)
             JOIN matrimony.member_profiles o ON o.agency_id = i.agency_id AND o.id IN (i.sender_profile_id, i.recipient_profile_id) AND o.id <> p.id
            WHERE i.agency_id = $1 AND i.id = $3 AND p.assigned_agent_id IS NOT NULL
         ) w
        WHERE w.account_id <> $4::uuid`,
      [agencyId, meetingId, interestId, actorId],
    );
  }
}
