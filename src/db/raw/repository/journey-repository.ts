import {
  JOURNEY_LIMIT,
  type Journey,
  type JourneyEvent,
  type JourneyEventKind,
  type JourneyWait,
  type WaitKind,
} from '../../../bo/journey.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

export interface JourneyProfile {
  id: string;
  memberCode: string;
  fullName: string;
  status: string;
  assignedAgentId: string | null;
  ownerAccountId: string | null;
}

const profileOf = (row: Row | undefined): JourneyProfile | null =>
  row
    ? {
        id: row.id as string,
        memberCode: row.member_code as string,
        fullName: row.full_name as string,
        status: row.status as string,
        assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
        ownerAccountId: (row.owner_account_id as string | null) ?? null,
      }
    : null;

// Every proposal that involves the client, with who the other person is. A request still waiting for the
// agent's review is the sender's alone to see: the person asked is not shown it, so it is not listed for them.
const MY_INTERESTS = `my AS (
  SELECT x.*, (x.sender_profile_id = $2) AS i_sent,
         CASE WHEN x.sender_profile_id = $2 THEN x.recipient_profile_id ELSE x.sender_profile_id END AS other_id
    FROM matrimony.interests x
   WHERE x.agency_id = $1 AND (x.sender_profile_id = $2 OR x.recipient_profile_id = $2)
     AND (x.sender_profile_id = $2 OR x.status <> 'in_review')
)`;

// $1 agency, $2 profile. One row per thing that happened, with the other person when there is one.
const EVENTS = `WITH ${MY_INTERESTS}, ev AS (
  SELECT 'profile_submitted'::text AS kind, r.created_at AS at, NULL::uuid AS other_id, false AS show_name,
         NULL::text AS detail, NULL::int AS count
    FROM matrimony.profile_reviews r
   WHERE r.agency_id = $1 AND r.profile_id = $2 AND r.kind = 'initial_submission'
  UNION ALL
  SELECT CASE r.status WHEN 'approved' THEN 'profile_approved' ELSE 'profile_rejected' END, r.reviewed_at,
         NULL, false, NULL, NULL
    FROM matrimony.profile_reviews r
   WHERE r.agency_id = $1 AND r.profile_id = $2 AND r.kind = 'initial_submission'
     AND r.status IN ('approved', 'rejected') AND r.reviewed_at IS NOT NULL
  UNION ALL
  SELECT 'verification_sent', v.submitted_at, NULL, false, NULL, NULL
    FROM matrimony.profile_verifications v
   WHERE v.agency_id = $1 AND v.profile_id = $2 AND v.status <> 'withdrawn'
  UNION ALL
  SELECT CASE v.status WHEN 'approved' THEN 'verification_approved' ELSE 'verification_rejected' END,
         v.decided_at, NULL, false, NULL, NULL
    FROM matrimony.profile_verifications v
   WHERE v.agency_id = $1 AND v.profile_id = $2 AND v.status IN ('approved', 'rejected') AND v.decided_at IS NOT NULL
  UNION ALL
  SELECT 'agent_assigned', a.created_at, NULL, false, g.display_name, NULL
    FROM matrimony.client_assignments a
    JOIN matrimony.accounts g ON g.agency_id = a.agency_id AND g.id = a.to_agent_id
   WHERE a.agency_id = $1 AND a.profile_id = $2 AND a.to_agent_id IS NOT NULL
  UNION ALL
  SELECT 'candidates_released', date_trunc('hour', c.decided_at), NULL, false, NULL, count(*)::int
    FROM matrimony.client_candidates c
   WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.state = 'released' AND c.decided_at IS NOT NULL
   GROUP BY date_trunc('hour', c.decided_at)
  UNION ALL
  SELECT 'proposal_sent', m.created_at, m.other_id, false, NULL, NULL FROM my m WHERE m.i_sent
  UNION ALL
  SELECT 'proposal_forwarded', m.reviewed_at, m.other_id, false, NULL, NULL FROM my m
   WHERE m.i_sent AND m.reviewed_at IS NOT NULL AND NOT (m.status = 'declined' AND m.responded_at IS NULL)
  UNION ALL
  SELECT 'proposal_not_forwarded', coalesce(m.reviewed_at, m.updated_at), m.other_id, false, NULL, NULL FROM my m
   WHERE m.i_sent AND m.status = 'declined' AND m.responded_at IS NULL
  UNION ALL
  SELECT 'proposal_declined_by_them', m.responded_at, m.other_id, false, NULL, NULL FROM my m
   WHERE m.i_sent AND m.status = 'declined' AND m.responded_at IS NOT NULL
  UNION ALL
  SELECT 'proposal_received', coalesce(m.reviewed_at, m.created_at), m.other_id, false, NULL, NULL FROM my m
   WHERE NOT m.i_sent
  UNION ALL
  SELECT 'proposal_declined_by_me', m.responded_at, m.other_id, false, NULL, NULL FROM my m
   WHERE NOT m.i_sent AND m.status = 'declined' AND m.responded_at IS NOT NULL
  UNION ALL
  SELECT 'proposal_accepted', m.responded_at, m.other_id, true, NULL, NULL FROM my m
   WHERE m.status = 'accepted' AND m.responded_at IS NOT NULL
  UNION ALL
  SELECT 'proposal_withdrawn', m.updated_at, m.other_id, false, NULL, NULL FROM my m
   WHERE m.i_sent AND m.status = 'withdrawn'
  UNION ALL
  SELECT CASE WHEN m.i_sent THEN 'contact_shared_by_me' ELSE 'contact_shared_by_them' END,
         m.sender_contact_consent_at, m.other_id, true, NULL, NULL FROM my m
   WHERE m.status = 'accepted' AND m.sender_contact_consent_at IS NOT NULL
  UNION ALL
  SELECT CASE WHEN m.i_sent THEN 'contact_shared_by_them' ELSE 'contact_shared_by_me' END,
         m.recipient_contact_consent_at, m.other_id, true, NULL, NULL FROM my m
   WHERE m.status = 'accepted' AND m.recipient_contact_consent_at IS NOT NULL
  UNION ALL
  SELECT 'meeting_scheduled', t.created_at, m.other_id, true, t.kind, NULL
    FROM matrimony.meetings t JOIN my m ON m.id = t.interest_id AND m.status = 'accepted'
   WHERE t.agency_id = $1 AND t.status <> 'cancelled'
  UNION ALL
  SELECT 'meeting_done', t.updated_at, m.other_id, true, t.kind, NULL
    FROM matrimony.meetings t JOIN my m ON m.id = t.interest_id AND m.status = 'accepted'
   WHERE t.agency_id = $1 AND t.status = 'done'
  UNION ALL
  SELECT 'matched', k.matched_at,
         CASE WHEN k.profile_a = $2 THEN k.profile_b ELSE k.profile_a END, true, NULL, NULL
    FROM matrimony.couple_matches k
   WHERE k.agency_id = $1 AND (k.profile_a = $2 OR k.profile_b = $2)
  UNION ALL
  SELECT 'unmatched', k.undone_at,
         CASE WHEN k.profile_a = $2 THEN k.profile_b ELSE k.profile_a END, true, NULL, NULL
    FROM matrimony.couple_matches k
   WHERE k.agency_id = $1 AND (k.profile_a = $2 OR k.profile_b = $2) AND k.undone_at IS NOT NULL
  UNION ALL
  SELECT 'terms_recorded', s.created_at, NULL, false, s.version::text, NULL
    FROM matrimony.client_service_terms s WHERE s.agency_id = $1 AND s.profile_id = $2
  UNION ALL
  SELECT 'terms_confirmed', s.acknowledged_at, NULL, false, s.version::text, NULL
    FROM matrimony.client_service_terms s
   WHERE s.agency_id = $1 AND s.profile_id = $2 AND s.acknowledged_at IS NOT NULL
)
SELECT ev.kind, ev.at, ev.detail, ev.count, p.member_code,
       CASE WHEN $3::boolean OR ev.show_name THEN p.full_name END AS full_name
  FROM ev LEFT JOIN matrimony.member_profiles p ON p.agency_id = $1 AND p.id = ev.other_id
 WHERE ev.at IS NOT NULL
 ORDER BY ev.at DESC, ev.kind
 LIMIT $4`;

// $1 agency, $2 profile, $3 staff view. What each side is waiting for, with since when.
const WAITING = `WITH ${MY_INTERESTS}, w AS (
  SELECT 'profile_review'::text AS kind, 'agency'::text AS side, r.created_at AS since, NULL::uuid AS other_id
    FROM matrimony.profile_reviews r
   WHERE r.agency_id = $1 AND r.profile_id = $2 AND r.status = 'pending' AND r.kind IN ('initial_submission', 'field_update')
  UNION ALL
  SELECT 'verification', 'agency', v.submitted_at, NULL
    FROM matrimony.profile_verifications v WHERE v.agency_id = $1 AND v.profile_id = $2 AND v.status = 'pending'
  UNION ALL
  SELECT 'proposal_review', 'agency', coalesce(m.review_started_at, m.created_at), m.other_id
    FROM my m WHERE m.i_sent AND m.status = 'in_review'
  UNION ALL
  SELECT 'meeting_outcome', 'agency', t.scheduled_at, m.other_id
    FROM matrimony.meetings t JOIN my m ON m.id = t.interest_id
   WHERE t.agency_id = $1 AND t.status = 'scheduled' AND t.scheduled_at < now()
  UNION ALL
  SELECT 'answer_request', 'you', coalesce(m.reviewed_at, m.created_at), m.other_id
    FROM my m WHERE NOT m.i_sent AND m.status = 'pending'
  UNION ALL
  SELECT 'confirm_terms', 'you', s.created_at, NULL
    FROM matrimony.client_service_terms s
   WHERE s.agency_id = $1 AND s.profile_id = $2 AND s.acknowledged_at IS NULL
     AND s.version = (SELECT max(version) FROM matrimony.client_service_terms WHERE agency_id = $1 AND profile_id = $2)
  UNION ALL
  SELECT 'their_answer', 'others', coalesce(m.reviewed_at, m.created_at), m.other_id
    FROM my m WHERE m.i_sent AND m.status = 'pending'
)
SELECT w.kind, w.side, w.since, p.member_code,
       CASE WHEN $3::boolean THEN p.full_name END AS full_name
  FROM w LEFT JOIN matrimony.member_profiles p ON p.agency_id = $1 AND p.id = w.other_id
 ORDER BY w.since ASC`;

// $1 agency, $2 profile.
const COUNTS = `WITH ${MY_INTERESTS}
SELECT
  (SELECT count(*) FROM matrimony.client_candidates c
    WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.state = 'released')::int AS released,
  (SELECT count(*) FROM my WHERE i_sent)::int AS sent,
  (SELECT count(*) FROM my WHERE NOT i_sent)::int AS received,
  (SELECT count(*) FROM my WHERE status = 'accepted')::int AS accepted,
  (SELECT count(*) FROM matrimony.meetings t JOIN my m ON m.id = t.interest_id
    WHERE t.agency_id = $1 AND t.status <> 'cancelled')::int AS meetings`;

const person = (row: Row) =>
  row.member_code
    ? { memberCode: row.member_code as string, fullName: (row.full_name as string | null) ?? null }
    : null;

/** Reads what the platform recorded about one client's search. Nothing is written. */
export class JourneyRepository {
  async profileById(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT id, member_code, full_name, status, assigned_agent_id, owner_account_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    return profileOf(result.rows[0] as Row | undefined);
  }

  async ownProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT id, member_code, full_name, status, assigned_agent_id, owner_account_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND owner_account_id = $2`,
      [agencyId, accountId],
    );
    return profileOf(result.rows[0] as Row | undefined);
  }

  async journey(
    tx: Transaction,
    agencyId: string,
    profile: JourneyProfile,
    staff: boolean,
  ): Promise<Journey> {
    const [events, waiting, counts] = await Promise.all([
      tx.query(EVENTS, [agencyId, profile.id, staff, JOURNEY_LIMIT]),
      tx.query(WAITING, [agencyId, profile.id, staff]),
      tx.query(COUNTS, [agencyId, profile.id]),
    ]);
    const wait = (side: string): JourneyWait[] =>
      (waiting.rows as Row[])
        .filter((row) => row.side === side)
        .map((row) => ({
          kind: row.kind as WaitKind,
          since: (row.since as Date).toISOString(),
          with: person(row),
        }));
    const c = counts.rows[0] as Row;
    return {
      profile: {
        id: profile.id,
        memberCode: profile.memberCode,
        fullName: profile.fullName,
        status: profile.status,
      },
      summary: {
        released: Number(c.released),
        proposalsSent: Number(c.sent),
        proposalsReceived: Number(c.received),
        accepted: Number(c.accepted),
        meetings: Number(c.meetings),
      },
      waiting: { onAgency: wait('agency'), onYou: wait('you'), onOthers: wait('others') },
      events: (events.rows as Row[]).map((row): JourneyEvent => ({
        at: (row.at as Date).toISOString(),
        kind: row.kind as JourneyEventKind,
        with: person(row),
        count: row.count === null ? null : Number(row.count),
        detail: (row.detail as string | null) ?? null,
      })),
    };
  }
}
