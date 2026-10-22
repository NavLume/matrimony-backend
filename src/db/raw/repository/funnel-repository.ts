import type { StageTimes } from '../../../bo/funnel.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

const time = (value: unknown): Date | null => (value ? (value as Date) : null);

/**
 * When each person who registered in a period reached each stage of the funnel (see bo/funnel.ts), read from
 * what the platform already stores. One row per person, nine times each.
 */
export class FunnelRepository {
  async people(
    tx: Transaction,
    agencyId: string,
    scope: { from: string | null; to: string | null; agentId: string | null },
  ): Promise<StageTimes[]> {
    const result = await tx.query(
      `WITH people AS (
         SELECT p.id AS profile_id, coalesce(a.created_at, p.created_at) AS t1, p.assigned_agent_id AS agent
           FROM matrimony.member_profiles p
           LEFT JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.owner_account_id
          WHERE p.agency_id = $1
         UNION ALL
         SELECT NULL::uuid, a.created_at, NULL::uuid
           FROM matrimony.accounts a
          WHERE a.agency_id = $1 AND a.role = 'member' AND $4::uuid IS NULL
            AND NOT EXISTS (SELECT 1 FROM matrimony.member_profiles p
                             WHERE p.agency_id = a.agency_id AND p.owner_account_id = a.id)),
       cohort AS (
         SELECT * FROM people
          WHERE ($2::date IS NULL OR t1 >= $2::date)
            AND ($3::date IS NULL OR t1 < $3::date + 1)
            AND ($4::uuid IS NULL OR agent = $4::uuid)),
       submitted AS (
         SELECT profile_id, min(created_at) AS t FROM matrimony.profile_reviews
          WHERE agency_id = $1 AND kind = 'initial_submission' GROUP BY profile_id),
       approved AS (
         SELECT profile_id, min(reviewed_at) AS t FROM matrimony.profile_reviews
          WHERE agency_id = $1 AND kind = 'initial_submission' AND status = 'approved' GROUP BY profile_id),
       assigned AS (
         SELECT profile_id, min(created_at) AS t FROM matrimony.client_assignments
          WHERE agency_id = $1 AND to_agent_id IS NOT NULL GROUP BY profile_id),
       fee AS (
         SELECT profile_id, min(t) AS t FROM (
           SELECT profile_id, updated_at AS t FROM matrimony.client_agreements WHERE agency_id = $1 AND amount > 0
           UNION ALL
           SELECT profile_id, created_at FROM matrimony.client_payments WHERE agency_id = $1 AND voided_at IS NULL) x
          GROUP BY profile_id),
       released AS (
         SELECT client_profile_id AS profile_id, min(decided_at) AS t FROM matrimony.client_candidates
          WHERE agency_id = $1 AND state IN ('released', 'lapsed') AND decided_at IS NOT NULL GROUP BY client_profile_id),
       requested AS (
         SELECT profile_id, min(t) AS t FROM (
           SELECT sender_profile_id AS profile_id, created_at AS t FROM matrimony.interests WHERE agency_id = $1
           UNION ALL
           SELECT recipient_profile_id, created_at FROM matrimony.interests
            WHERE agency_id = $1 AND status <> 'in_review') x
          GROUP BY profile_id),
       accepted AS (
         SELECT profile_id, min(t) AS t FROM (
           SELECT sender_profile_id AS profile_id, responded_at AS t FROM matrimony.interests
            WHERE agency_id = $1 AND status = 'accepted'
           UNION ALL
           SELECT recipient_profile_id, responded_at FROM matrimony.interests
            WHERE agency_id = $1 AND status = 'accepted') x
          GROUP BY profile_id),
       meeting AS (
         SELECT v.profile_id, min(m.created_at) AS t
           FROM matrimony.meetings m
           JOIN matrimony.interests i ON i.agency_id = m.agency_id AND i.id = m.interest_id
           CROSS JOIN LATERAL (VALUES (i.sender_profile_id), (i.recipient_profile_id)) v(profile_id)
          WHERE m.agency_id = $1 AND m.status <> 'cancelled' GROUP BY v.profile_id),
       matched AS (
         SELECT v.profile_id, min(cm.matched_at) AS t
           FROM matrimony.couple_matches cm
           CROSS JOIN LATERAL (VALUES (cm.profile_a), (cm.profile_b)) v(profile_id)
          WHERE cm.agency_id = $1 AND cm.undone_at IS NULL GROUP BY v.profile_id)
       SELECT c.t1, s.t AS t2, ap.t AS t3,
              CASE WHEN asg.t IS NOT NULL AND f.t IS NOT NULL THEN greatest(asg.t, f.t) END AS t4,
              r.t AS t5, rq.t AS t6, ac.t AS t7, mt.t AS t8, mc.t AS t9
         FROM cohort c
         LEFT JOIN submitted s ON s.profile_id = c.profile_id
         LEFT JOIN approved ap ON ap.profile_id = c.profile_id
         LEFT JOIN assigned asg ON asg.profile_id = c.profile_id
         LEFT JOIN fee f ON f.profile_id = c.profile_id
         LEFT JOIN released r ON r.profile_id = c.profile_id
         LEFT JOIN requested rq ON rq.profile_id = c.profile_id
         LEFT JOIN accepted ac ON ac.profile_id = c.profile_id
         LEFT JOIN meeting mt ON mt.profile_id = c.profile_id
         LEFT JOIN matched mc ON mc.profile_id = c.profile_id`,
      [agencyId, scope.from, scope.to, scope.agentId],
    );
    return (result.rows as Row[]).map((row) => [
      time(row.t1),
      time(row.t2),
      time(row.t3),
      time(row.t4),
      time(row.t5),
      time(row.t6),
      time(row.t7),
      time(row.t8),
      time(row.t9),
    ]);
  }
}
