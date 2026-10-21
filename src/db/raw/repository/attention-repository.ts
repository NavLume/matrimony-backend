import { parseSettings, type AttentionLimits } from '../../../bo/agency-settings.js';
import type { AttentionItem, AttentionKind } from '../../../bo/attention.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

// $1 agency, $2 the agent whose view this is (null for an admin), $3 days for a decision, $4 days for an
// unanswered request, $5 days with no profile released, $6 days with no meeting after an accepted request.
const ITEMS = `WITH items AS (
  SELECT 'review_waiting'::text AS kind, r.created_at AS since, p.id AS client_id, NULL::uuid AS with_id
    FROM matrimony.profile_reviews r
    JOIN matrimony.member_profiles p ON p.agency_id = r.agency_id AND p.id = r.profile_id
   WHERE r.agency_id = $1 AND r.status = 'pending' AND r.kind IN ('initial_submission', 'field_update', 'photo_add')
     AND r.created_at < now() - make_interval(days => $3::int)
     AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
  UNION ALL
  SELECT 'review_waiting', c.created_at, p.id, NULL
    FROM matrimony.profile_cvs c
    JOIN matrimony.member_profiles p ON p.agency_id = c.agency_id AND p.id = c.profile_id
   WHERE c.agency_id = $1 AND c.status = 'pending' AND c.created_at < now() - make_interval(days => $3::int)
     AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
  UNION ALL
  SELECT 'review_waiting', v.submitted_at, p.id, NULL
    FROM matrimony.profile_verifications v
    JOIN matrimony.member_profiles p ON p.agency_id = v.agency_id AND p.id = v.profile_id
   WHERE v.agency_id = $1 AND v.status = 'pending' AND v.submitted_at < now() - make_interval(days => $3::int)
     AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
  UNION ALL
  SELECT 'request_in_review', coalesce(x.review_started_at, x.created_at), x.recipient_profile_id, x.sender_profile_id
    FROM matrimony.interests x
    JOIN matrimony.member_profiles p ON p.agency_id = x.agency_id AND p.id = x.recipient_profile_id
   WHERE x.agency_id = $1 AND x.status = 'in_review'
     AND coalesce(x.review_started_at, x.created_at) < now() - make_interval(days => $3::int)
     AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
  UNION ALL
  SELECT 'request_unanswered', coalesce(x.reviewed_at, x.created_at), x.recipient_profile_id, x.sender_profile_id
    FROM matrimony.interests x
    JOIN matrimony.member_profiles p ON p.agency_id = x.agency_id AND p.id = x.recipient_profile_id
   WHERE x.agency_id = $1 AND x.status = 'pending'
     AND coalesce(x.reviewed_at, x.created_at) < now() - make_interval(days => $4::int)
     AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
  UNION ALL
  SELECT 'no_candidates', approved.at, p.id, NULL
    FROM matrimony.member_profiles p
    JOIN LATERAL (
      SELECT max(r.reviewed_at) AS at FROM matrimony.profile_reviews r
       WHERE r.agency_id = p.agency_id AND r.profile_id = p.id AND r.kind = 'initial_submission' AND r.status = 'approved'
    ) approved ON approved.at IS NOT NULL
   WHERE p.agency_id = $1 AND p.status = 'active' AND p.assigned_agent_id IS NOT NULL
     AND approved.at < now() - make_interval(days => $5::int)
     AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
     AND NOT EXISTS (SELECT 1 FROM matrimony.client_candidates c
                      WHERE c.agency_id = p.agency_id AND c.client_profile_id = p.id AND c.state = 'released')
  UNION ALL
  SELECT 'no_meeting', x.responded_at, x.sender_profile_id, x.recipient_profile_id
    FROM matrimony.interests x
    JOIN matrimony.member_profiles p ON p.agency_id = x.agency_id AND p.id = x.sender_profile_id
   WHERE x.agency_id = $1 AND x.status = 'accepted' AND x.responded_at < now() - make_interval(days => $6::int)
     AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
     AND NOT EXISTS (SELECT 1 FROM matrimony.meetings t WHERE t.agency_id = x.agency_id AND t.interest_id = x.id AND t.status <> 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM matrimony.couple_matches k WHERE k.agency_id = x.agency_id AND k.interest_id = x.id AND k.undone_at IS NULL)
  UNION ALL
  -- The other side of an accepted request, for the agent who looks after that person (an admin already saw it above).
  SELECT 'no_meeting', x.responded_at, x.recipient_profile_id, x.sender_profile_id
    FROM matrimony.interests x
    JOIN matrimony.member_profiles p ON p.agency_id = x.agency_id AND p.id = x.recipient_profile_id
   WHERE x.agency_id = $1 AND x.status = 'accepted' AND x.responded_at < now() - make_interval(days => $6::int)
     AND $2::uuid IS NOT NULL AND p.assigned_agent_id = $2
     AND NOT EXISTS (SELECT 1 FROM matrimony.meetings t WHERE t.agency_id = x.agency_id AND t.interest_id = x.id AND t.status <> 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM matrimony.couple_matches k WHERE k.agency_id = x.agency_id AND k.interest_id = x.id AND k.undone_at IS NULL)
)
SELECT i.kind, i.since, c.id AS client_id, c.member_code, c.full_name, c.assigned_agent_id, ag.display_name AS agent_name,
       w.member_code AS with_code, w.full_name AS with_name
  FROM items i
  JOIN matrimony.member_profiles c ON c.agency_id = $1 AND c.id = i.client_id
  LEFT JOIN matrimony.accounts ag ON ag.agency_id = $1 AND ag.id = c.assigned_agent_id
  LEFT JOIN matrimony.member_profiles w ON w.agency_id = $1 AND w.id = i.with_id
 ORDER BY i.since ASC
 LIMIT 300`;

const WORKLOAD = `SELECT a.id, a.display_name,
       count(p.id) FILTER (WHERE p.status = 'active')::int AS clients
  FROM matrimony.accounts a
  LEFT JOIN matrimony.member_profiles p ON p.agency_id = a.agency_id AND p.assigned_agent_id = a.id
 WHERE a.agency_id = $1 AND a.role = 'agent' AND a.status = 'active'
 GROUP BY a.id, a.display_name
 ORDER BY a.display_name`;

/** Reads what has waited too long. Nothing is written. */
export class AttentionRepository {
  /** The agency's own limits, in days. */
  async limits(tx: Transaction, agencyId: string): Promise<AttentionLimits> {
    const result = await tx.query(`SELECT settings FROM matrimony.agencies WHERE id = $1`, [
      agencyId,
    ]);
    return parseSettings((result.rows[0] as Row | undefined)?.settings).attention;
  }

  async items(
    tx: Transaction,
    agencyId: string,
    agentId: string | null,
    limits: AttentionLimits,
  ): Promise<AttentionItem[]> {
    const result = await tx.query(ITEMS, [
      agencyId,
      agentId,
      limits.reviewDays,
      limits.unansweredDays,
      limits.noCandidatesDays,
      limits.noMeetingDays,
    ]);
    return (result.rows as Row[]).map((row) => ({
      kind: row.kind as AttentionKind,
      since: (row.since as Date).toISOString(),
      client: {
        id: row.client_id as string,
        memberCode: row.member_code as string,
        fullName: row.full_name as string,
      },
      with: row.with_code
        ? { memberCode: row.with_code as string, fullName: row.with_name as string }
        : null,
      agent: row.assigned_agent_id
        ? { id: row.assigned_agent_id as string, displayName: row.agent_name as string }
        : null,
    }));
  }

  /** Every active agent with how many published clients they look after. */
  async agents(tx: Transaction, agencyId: string) {
    const result = await tx.query(WORKLOAD, [agencyId]);
    return (result.rows as Row[]).map((row) => ({
      agentId: row.id as string,
      displayName: row.display_name as string,
      clients: Number(row.clients),
    }));
  }
}
