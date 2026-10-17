import type {
  AgentReport,
  ClientMoney,
  NetworkEdge,
  NetworkNode,
  ProposalRow,
  ProposalStatus,
} from '../../../bo/report.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

const POSITION = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const num = (value: unknown) => Number(value ?? 0);

/** The financial year a payment date falls in, named by the year it starts in (July to June). */
const YEAR_OF = (column: string, basisParam: string) =>
  `(CASE WHEN ${basisParam}::text = 'fiscal'
         THEN extract(year FROM (${column} - interval '6 months'))
         ELSE extract(year FROM ${column}) END)::int`;

const side = (prefix: string, row: Row) => ({
  profileId: row[`${prefix}_id`] as string,
  memberCode: row[`${prefix}_code`] as string,
  fullName: row[`${prefix}_name`] as string,
  gender: (row[`${prefix}_gender`] as string | null) ?? null,
  agentName: (row[`${prefix}_agent`] as string | null) ?? null,
});

/** The numbers behind the admin's reports. Read only. */
export class ReportRepository {
  async accountsByRole(tx: Transaction, agencyId: string) {
    const result = await tx.query(
      `SELECT role, count(*)::int AS n FROM matrimony.accounts
        WHERE agency_id = $1 AND status = 'active' AND erased_at IS NULL GROUP BY role`,
      [agencyId],
    );
    return Object.fromEntries((result.rows as Row[]).map((r) => [r.role as string, num(r.n)]));
  }

  async profilesByStatus(tx: Transaction, agencyId: string) {
    const result = await tx.query(
      `SELECT status, service_mode, count(*)::int AS n FROM matrimony.member_profiles
        WHERE agency_id = $1 GROUP BY status, service_mode`,
      [agencyId],
    );
    return (result.rows as Row[]).map((r) => ({
      status: r.status as string,
      serviceMode: r.service_mode as string,
      n: num(r.n),
    }));
  }

  async waiting(tx: Transaction, agencyId: string) {
    const result = await tx.query(
      `SELECT
         (SELECT count(*) FROM matrimony.profile_reviews WHERE agency_id = $1 AND status = 'pending')::int AS profile_reviews,
         (SELECT count(*) FROM matrimony.interests WHERE agency_id = $1 AND status = 'in_review')::int AS proposal_reviews,
         (SELECT count(*) FROM matrimony.profile_cvs WHERE agency_id = $1 AND status = 'pending')::int AS cvs`,
      [agencyId],
    );
    const row = result.rows[0] as Row;
    return {
      profileReviews: num(row.profile_reviews),
      proposalReviews: num(row.proposal_reviews),
      cvs: num(row.cvs),
    };
  }

  async proposalCounts(tx: Transaction, agencyId: string) {
    const result = await tx.query(
      `SELECT status, count(*)::int AS n,
              count(*) FILTER (WHERE sender_contact_consent_at IS NOT NULL
                                  OR recipient_contact_consent_at IS NOT NULL)::int AS shared,
              count(*) FILTER (WHERE sender_contact_consent_at IS NOT NULL
                                 AND recipient_contact_consent_at IS NOT NULL)::int AS both_shared
         FROM matrimony.interests WHERE agency_id = $1 GROUP BY status`,
      [agencyId],
    );
    return (result.rows as Row[]).map((r) => ({
      status: r.status as ProposalStatus,
      n: num(r.n),
      shared: num(r.shared),
      bothShared: num(r.both_shared),
    }));
  }

  /** The last twelve months in Bangladesh time, the current one last. */
  async months(tx: Transaction, agencyId: string) {
    const result = await tx.query(
      `WITH months AS (
         SELECT generate_series(
                  date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') - interval '11 months',
                  date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka'),
                  interval '1 month') AS m)
       SELECT to_char(m, 'YYYY-MM') AS month,
         (SELECT count(*) FROM matrimony.member_profiles p
           WHERE p.agency_id = $1 AND date_trunc('month', p.created_at AT TIME ZONE 'Asia/Dhaka') = m)::int AS registrations,
         (SELECT count(*) FROM matrimony.interests i
           WHERE i.agency_id = $1 AND date_trunc('month', i.created_at AT TIME ZONE 'Asia/Dhaka') = m)::int AS proposals,
         (SELECT count(*) FROM matrimony.interests i
           WHERE i.agency_id = $1 AND i.status = 'accepted'
             AND date_trunc('month', i.responded_at AT TIME ZONE 'Asia/Dhaka') = m)::int AS accepted
       FROM months ORDER BY m`,
      [agencyId],
    );
    return (result.rows as Row[]).map((r) => ({
      month: r.month as string,
      registrations: num(r.registrations),
      proposals: num(r.proposals),
      accepted: num(r.accepted),
    }));
  }

  async agents(
    tx: Transaction,
    agencyId: string,
    from: string,
    to: string,
  ): Promise<AgentReport[]> {
    const result = await tx.query(
      `SELECT a.id, a.display_name, a.role,
         (SELECT count(*) FROM matrimony.member_profiles p
           WHERE p.agency_id = a.agency_id AND p.assigned_agent_id = a.id)::int AS clients,
         (SELECT count(*) FROM matrimony.member_profiles p
           WHERE p.agency_id = a.agency_id AND p.assigned_agent_id = a.id AND p.status = 'active')::int AS active_clients,
         (SELECT count(*) FROM matrimony.member_profiles p
           WHERE p.agency_id = a.agency_id AND p.assigned_agent_id = a.id AND p.status = 'matched')::int AS matched_clients,
         (SELECT count(*) FROM matrimony.interests i
           WHERE i.agency_id = a.agency_id AND i.reviewed_by_account_id = a.id)::int AS reviewed,
         (SELECT avg(extract(epoch FROM (i.reviewed_at - i.review_started_at))) / 3600
            FROM matrimony.interests i
           WHERE i.agency_id = a.agency_id AND i.reviewed_by_account_id = a.id
             AND i.reviewed_at IS NOT NULL AND i.review_started_at IS NOT NULL) AS avg_hours,
         (SELECT count(*) FROM matrimony.interests i
            JOIN matrimony.member_profiles r ON r.agency_id = i.agency_id AND r.id = i.recipient_profile_id
           WHERE i.agency_id = a.agency_id AND i.status = 'in_review'
             AND r.assigned_agent_id = a.id)::int AS waiting,
         (SELECT coalesce(sum(c.amount), 0) FROM matrimony.client_payments c
           WHERE c.agency_id = a.agency_id AND c.received_by = a.id AND c.voided_at IS NULL
             AND c.paid_on >= $2::date AND c.paid_on < $3::date)::bigint AS collected
         FROM matrimony.accounts a
        WHERE a.agency_id = $1 AND a.role IN ('admin', 'agent') AND a.status = 'active'
        ORDER BY collected DESC, a.display_name`,
      [agencyId, from, to],
    );
    return (result.rows as Row[]).map((r) => ({
      id: r.id as string,
      name: r.display_name as string,
      role: r.role as 'admin' | 'agent',
      clients: num(r.clients),
      activeClients: num(r.active_clients),
      matchedClients: num(r.matched_clients),
      requestsReviewed: num(r.reviewed),
      averageReviewHours: r.avg_hours === null ? null : Math.round(Number(r.avg_hours) * 10) / 10,
      waitingForReview: num(r.waiting),
      collected: num(r.collected),
    }));
  }

  /** Collected per financial (or calendar) year, every year that has a payment. */
  async yearlyMoney(tx: Transaction, agencyId: string, basis: string) {
    const result = await tx.query(
      `SELECT ${YEAR_OF('paid_on', '$2')} AS year, sum(amount)::bigint AS total
         FROM matrimony.client_payments
        WHERE agency_id = $1 AND voided_at IS NULL GROUP BY 1 ORDER BY 1`,
      [agencyId, basis],
    );
    return (result.rows as Row[]).map((r) => ({ year: num(r.year), total: num(r.total) }));
  }

  /** Collected per month and stage inside one year. */
  async monthlyMoney(tx: Transaction, agencyId: string, from: string, to: string) {
    const result = await tx.query(
      `SELECT to_char(paid_on, 'YYYY-MM') AS month, stage, sum(amount)::bigint AS total
         FROM matrimony.client_payments
        WHERE agency_id = $1 AND voided_at IS NULL AND paid_on >= $2::date AND paid_on < $3::date
        GROUP BY 1, 2`,
      [agencyId, from, to],
    );
    return (result.rows as Row[]).map((r) => ({
      month: r.month as string,
      stage: r.stage as 'registration' | 'success',
      total: num(r.total),
    }));
  }

  /** Every client with an agreement or a payment: what was agreed and what was paid, all time. */
  async clientMoney(tx: Transaction, agencyId: string): Promise<ClientMoney[]> {
    const result = await tx.query(
      `SELECT p.id, p.member_code, p.full_name, ag.display_name AS agent_name,
              coalesce((SELECT sum(g.amount) FROM matrimony.client_agreements g
                         WHERE g.agency_id = p.agency_id AND g.profile_id = p.id), 0)::bigint AS agreed,
              coalesce((SELECT sum(c.amount) FROM matrimony.client_payments c
                         WHERE c.agency_id = p.agency_id AND c.profile_id = p.id
                           AND c.voided_at IS NULL), 0)::bigint AS paid
         FROM matrimony.member_profiles p
         LEFT JOIN matrimony.accounts ag ON ag.agency_id = p.agency_id AND ag.id = p.assigned_agent_id
        WHERE p.agency_id = $1
          AND (EXISTS (SELECT 1 FROM matrimony.client_agreements g WHERE g.agency_id = p.agency_id AND g.profile_id = p.id)
            OR EXISTS (SELECT 1 FROM matrimony.client_payments c WHERE c.agency_id = p.agency_id AND c.profile_id = p.id))
        ORDER BY paid DESC, agreed DESC, p.member_code
        LIMIT 100`,
      [agencyId],
    );
    return (result.rows as Row[]).map((r) => ({
      profileId: r.id as string,
      memberCode: r.member_code as string,
      fullName: r.full_name as string,
      agentName: (r.agent_name as string | null) ?? null,
      agreed: num(r.agreed),
      paid: num(r.paid),
    }));
  }

  async moneyTotals(tx: Transaction, agencyId: string) {
    const result = await tx.query(
      `SELECT
         (SELECT coalesce(sum(amount), 0) FROM matrimony.client_agreements WHERE agency_id = $1)::bigint AS agreed,
         (SELECT coalesce(sum(amount), 0) FROM matrimony.client_payments WHERE agency_id = $1 AND voided_at IS NULL)::bigint AS paid`,
      [agencyId],
    );
    const row = result.rows[0] as Row;
    return { agreed: num(row.agreed), paid: num(row.paid) };
  }

  async matchedClients(tx: Transaction, agencyId: string) {
    const result = await tx.query(
      `SELECT count(*)::int AS n FROM matrimony.member_profiles WHERE agency_id = $1 AND status = 'matched'`,
      [agencyId],
    );
    return num((result.rows[0] as Row).n);
  }

  async proposals(
    tx: Transaction,
    agencyId: string,
    filter: { status: string | null; text: string | null },
    page: { limit: number; after: { createdAt: string; id: string } | null },
  ): Promise<(ProposalRow & { position: string })[]> {
    const result = await tx.query(
      `SELECT i.id, i.status, i.created_at, ${POSITION('i.created_at')} AS position, i.responded_at,
              (i.sender_contact_consent_at IS NOT NULL) AS from_shared,
              (i.recipient_contact_consent_at IS NOT NULL) AS to_shared,
              s.id AS s_id, s.member_code AS s_code, s.full_name AS s_name, s.gender AS s_gender, sa.display_name AS s_agent,
              r.id AS r_id, r.member_code AS r_code, r.full_name AS r_name, r.gender AS r_gender, ra.display_name AS r_agent
         FROM matrimony.interests i
         JOIN matrimony.member_profiles s ON s.agency_id = i.agency_id AND s.id = i.sender_profile_id
         JOIN matrimony.member_profiles r ON r.agency_id = i.agency_id AND r.id = i.recipient_profile_id
         LEFT JOIN matrimony.accounts sa ON sa.agency_id = s.agency_id AND sa.id = s.assigned_agent_id
         LEFT JOIN matrimony.accounts ra ON ra.agency_id = r.agency_id AND ra.id = r.assigned_agent_id
        WHERE i.agency_id = $1
          AND ($2::text IS NULL OR i.status = $2::text)
          AND ($3::timestamptz IS NULL OR (i.created_at, i.id) < ($3::timestamptz, $4::uuid))
          AND ($5::text IS NULL
               OR s.member_code ILIKE '%' || $5 || '%' OR r.member_code ILIKE '%' || $5 || '%'
               OR s.full_name ILIKE '%' || $5 || '%' OR r.full_name ILIKE '%' || $5 || '%')
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT $6`,
      [
        agencyId,
        filter.status,
        page.after?.createdAt ?? null,
        page.after?.id ?? null,
        filter.text,
        page.limit + 1,
      ],
    );
    return (result.rows as Row[]).map((r) => ({
      id: r.id as string,
      status: r.status as ProposalStatus,
      createdAt: (r.created_at as Date).toISOString(),
      respondedAt: r.responded_at ? (r.responded_at as Date).toISOString() : null,
      from: side('s', r),
      to: side('r', r),
      fromSharedContact: r.from_shared === true,
      toSharedContact: r.to_shared === true,
      position: r.position as string,
    }));
  }

  /** The proposals to draw: one client's (any open or answered one) or the agency's accepted ones. */
  async edges(
    tx: Transaction,
    agencyId: string,
    client: string | null,
    limit: number,
  ): Promise<NetworkEdge[]> {
    const result = await tx.query(
      `SELECT id, sender_profile_id, recipient_profile_id, status FROM matrimony.interests
        WHERE agency_id = $1
          AND (($2::uuid IS NOT NULL AND status <> 'withdrawn'
                AND (sender_profile_id = $2::uuid OR recipient_profile_id = $2::uuid))
            OR ($2::uuid IS NULL AND status = 'accepted'))
        ORDER BY coalesce(responded_at, created_at) DESC, id DESC
        LIMIT $3`,
      [agencyId, client, limit],
    );
    return (result.rows as Row[]).map((r) => ({
      id: r.id as string,
      from: r.sender_profile_id as string,
      to: r.recipient_profile_id as string,
      status: r.status as ProposalStatus,
    }));
  }

  async nodes(tx: Transaction, agencyId: string, ids: string[]): Promise<NetworkNode[]> {
    if (ids.length === 0) return [];
    const result = await tx.query(
      `SELECT id, member_code, full_name, gender FROM matrimony.member_profiles
        WHERE agency_id = $1 AND id = ANY($2::uuid[])`,
      [agencyId, ids],
    );
    return (result.rows as Row[]).map((r) => ({
      profileId: r.id as string,
      memberCode: r.member_code as string,
      fullName: r.full_name as string,
      gender: (r.gender as string | null) ?? null,
    }));
  }
}
