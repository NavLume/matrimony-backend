import {
  BURST_HOURS,
  BURST_REQUESTS,
  REJECTED_DOCUMENTS,
  REPORTERS,
  REPORT_DAYS,
  type FlagOutcome,
  type FlagRow,
  type Signal,
} from '../../../bo/flags.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

/**
 * Every flag that applies now, found in what the platform already holds (see bo/flags.ts). Each part of the query
 * yields one row per profile and signal: who it matches, how many, and when the newest evidence appeared.
 */
const DETECTED = `
  WITH phones AS (
    SELECT p.id AS profile_id, p.owner_account_id AS owner, c.phone_e164 AS v, p.created_at AS at
      FROM matrimony.member_profiles p
      JOIN matrimony.profile_contacts c ON c.agency_id = p.agency_id AND c.profile_id = p.id
     WHERE p.agency_id = $1 AND p.status <> 'closed' AND p.erased_at IS NULL AND c.phone_e164 IS NOT NULL
    UNION ALL
    SELECT p.id, p.owner_account_id, a.phone_e164, p.created_at
      FROM matrimony.member_profiles p
      JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.owner_account_id
     WHERE p.agency_id = $1 AND p.status <> 'closed' AND p.erased_at IS NULL AND a.phone_e164 IS NOT NULL),
  emails AS (
    SELECT p.id AS profile_id, p.owner_account_id AS owner, lower(c.email) AS v, p.created_at AS at
      FROM matrimony.member_profiles p
      JOIN matrimony.profile_contacts c ON c.agency_id = p.agency_id AND c.profile_id = p.id
     WHERE p.agency_id = $1 AND p.status <> 'closed' AND p.erased_at IS NULL AND c.email IS NOT NULL
    UNION ALL
    SELECT p.id, p.owner_account_id, lower(a.email), p.created_at
      FROM matrimony.member_profiles p
      JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.owner_account_id
     WHERE p.agency_id = $1 AND p.status <> 'closed' AND p.erased_at IS NULL AND a.email IS NOT NULL),
  detected AS (
    SELECT x.profile_id, 'shared_phone' AS signal, array_agg(DISTINCT q.member_code) AS others,
           count(DISTINCT y.profile_id)::int AS n, max(greatest(x.at, y.at)) AS evidence
      FROM phones x
      JOIN phones y ON y.v = x.v AND y.profile_id <> x.profile_id
       AND (x.owner IS NULL OR y.owner IS DISTINCT FROM x.owner)
      JOIN matrimony.member_profiles q ON q.agency_id = $1 AND q.id = y.profile_id
     GROUP BY x.profile_id
    UNION ALL
    SELECT x.profile_id, 'shared_email', array_agg(DISTINCT q.member_code),
           count(DISTINCT y.profile_id)::int, max(greatest(x.at, y.at))
      FROM emails x
      JOIN emails y ON y.v = x.v AND y.profile_id <> x.profile_id
       AND (x.owner IS NULL OR y.owner IS DISTINCT FROM x.owner)
      JOIN matrimony.member_profiles q ON q.agency_id = $1 AND q.id = y.profile_id
     GROUP BY x.profile_id
    UNION ALL
    SELECT a.profile_id, 'shared_photo', array_agg(DISTINCT q.member_code),
           count(DISTINCT b.profile_id)::int, max(greatest(a.created_at, b.created_at))
      FROM matrimony.profile_photos a
      JOIN matrimony.member_profiles pa ON pa.agency_id = a.agency_id AND pa.id = a.profile_id
      JOIN matrimony.profile_photos b ON b.agency_id = a.agency_id AND b.content_hash = a.content_hash
       AND b.profile_id <> a.profile_id AND b.status <> 'removed'
      JOIN matrimony.member_profiles pb ON pb.agency_id = b.agency_id AND pb.id = b.profile_id
      JOIN matrimony.member_profiles q ON q.agency_id = a.agency_id AND q.id = b.profile_id
     WHERE a.agency_id = $1 AND a.content_hash IS NOT NULL AND a.status <> 'removed'
       AND pa.status <> 'closed' AND pb.status <> 'closed' AND pa.erased_at IS NULL AND pb.erased_at IS NULL
       AND (pa.owner_account_id IS NULL OR pb.owner_account_id IS DISTINCT FROM pa.owner_account_id)
     GROUP BY a.profile_id
    UNION ALL
    SELECT i.sender_profile_id, 'request_burst', '{}'::text[], count(*)::int, max(i.created_at)
      FROM matrimony.interests i
     WHERE i.agency_id = $1 AND i.created_at > now() - make_interval(hours => ${BURST_HOURS})
     GROUP BY i.sender_profile_id
    HAVING count(*) >= ${BURST_REQUESTS}
    UNION ALL
    SELECT c.about_profile_id, 'reported_by_several', '{}'::text[],
           count(DISTINCT coalesce(c.reporter_account_id, c.for_profile_id))::int, max(c.created_at)
      FROM matrimony.concern_reports c
     WHERE c.agency_id = $1 AND c.about_kind = 'profile' AND c.about_profile_id IS NOT NULL
       AND c.created_at > now() - make_interval(days => ${REPORT_DAYS})
     GROUP BY c.about_profile_id
    HAVING count(DISTINCT coalesce(c.reporter_account_id, c.for_profile_id)) >= ${REPORTERS}
    UNION ALL
    SELECT v.profile_id, 'document_rejected_twice', '{}'::text[], count(*)::int, max(v.decided_at)
      FROM matrimony.profile_verifications v
     WHERE v.agency_id = $1 AND v.status = 'rejected'
     GROUP BY v.profile_id
    HAVING count(*) >= ${REJECTED_DOCUMENTS})
  SELECT d.profile_id, d.signal, d.others, d.n, d.evidence,
         p.member_code, p.full_name, p.assigned_agent_id,
         CASE WHEN r.reviewed_at IS NULL OR d.evidence > r.reviewed_at THEN 'open' ELSE r.outcome END AS status,
         CASE WHEN r.reviewed_at IS NULL OR d.evidence > r.reviewed_at THEN NULL ELSE ra.display_name END AS reviewed_by,
         CASE WHEN r.reviewed_at IS NULL OR d.evidence > r.reviewed_at THEN NULL ELSE r.reviewed_at END AS reviewed_at
    FROM detected d
    JOIN matrimony.member_profiles p ON p.agency_id = $1 AND p.id = d.profile_id
     AND p.status <> 'closed' AND p.erased_at IS NULL
    LEFT JOIN matrimony.fraud_flag_reviews r ON r.agency_id = $1 AND r.profile_id = d.profile_id AND r.signal = d.signal
    LEFT JOIN matrimony.accounts ra ON ra.agency_id = $1 AND ra.id = r.reviewed_by
   WHERE ($2::uuid IS NULL OR d.profile_id = $2::uuid)
     AND ($3::uuid IS NULL OR p.assigned_agent_id = $3::uuid)
   ORDER BY d.evidence DESC, p.member_code, d.signal`;

const flagOf = (row: Row): FlagRow => ({
  profileId: row.profile_id as string,
  memberCode: row.member_code as string,
  fullName: row.full_name as string,
  signal: row.signal as Signal,
  others: (row.others as string[]) ?? [],
  count: row.n as number,
  evidenceAt: (row.evidence as Date).toISOString(),
  status: row.status as FlagRow['status'],
  reviewedBy: (row.reviewed_by as string | null) ?? null,
  reviewedAt: row.reviewed_at ? (row.reviewed_at as Date).toISOString() : null,
});

/** The flags staff see (see bo/flags.ts). Never read for a member. */
export class FlagRepository {
  /**
   * The flags that apply now. An agent is given their own clients' only (`agentId`); an admin all. `profileId`
   * narrows to one profile.
   */
  async list(
    tx: Transaction,
    agencyId: string,
    scope: { profileId: string | null; agentId: string | null },
  ): Promise<FlagRow[]> {
    const result = await tx.query(DETECTED, [agencyId, scope.profileId, scope.agentId]);
    return (result.rows as Row[]).map(flagOf);
  }

  /** The profile and who looks after it, so access can be decided. */
  async profile(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT assigned_agent_id FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? { assignedAgentId: (row.assigned_agent_id as string | null) ?? null } : null;
  }

  /** Records what a staff member decided; a second decision replaces the first. */
  async review(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    signal: Signal,
    outcome: FlagOutcome,
    by: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.fraud_flag_reviews (agency_id, profile_id, signal, outcome, reviewed_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agency_id, profile_id, signal)
       DO UPDATE SET outcome = EXCLUDED.outcome, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
      [agencyId, profileId, signal, outcome, by],
    );
  }
}
