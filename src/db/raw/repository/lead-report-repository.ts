import type { Transaction } from '../../config/database.js';
import type { LeadSource } from '../../../bo/consultation.js';
import type { FunnelCounts, SharedPayment } from '../../../bo/lead-report.js';

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value ?? 0);
const BD_DAY = (column: string) => `(${column} AT TIME ZONE 'Asia/Dhaka')::date`;

/**
 * The enquiries made in the period ($2 to $3, Bangladesh days), and for each client the first of their enquiries in
 * it, so a client's payments are counted once even when they left two enquiries. Payments count when they were made
 * on or after the day of that enquiry and were not cancelled.
 */
const LEADS_IN_PERIOD = `
  leads AS (
    SELECT l.id, coalesce(l.source, 'direct') AS source, l.utm_campaign, l.verified_at, l.first_contact_at,
           l.client_profile_id, l.created_at
      FROM matrimony.website_leads l
     WHERE l.agency_id = $1 AND l.kind = 'consultation'
       AND ${BD_DAY('l.created_at')} BETWEEN $2::date AND $3::date),
  first_per_client AS (
    SELECT DISTINCT ON (client_profile_id) id, client_profile_id, created_at
      FROM leads WHERE client_profile_id IS NOT NULL
     ORDER BY client_profile_id, created_at, id),
  paid AS (
    SELECT f.id, sum(p.amount) AS paid
      FROM first_per_client f
      JOIN matrimony.client_payments p
        ON p.agency_id = $1 AND p.profile_id = f.client_profile_id AND p.voided_at IS NULL
       AND p.paid_on >= ${BD_DAY('f.created_at')}
     GROUP BY f.id)`;

const COUNTS = `count(*)::int AS leads, count(l.verified_at)::int AS verified,
       count(l.first_contact_at)::int AS contacted, count(l.client_profile_id)::int AS clients,
       count(paid.id)::int AS paying, coalesce(sum(paid.paid), 0)::bigint AS paid`;

const toCounts = (row: Row): Omit<FunnelCounts, 'visits'> => ({
  leads: num(row.leads),
  verified: num(row.verified),
  contacted: num(row.contacted),
  clients: num(row.clients),
  paying: num(row.paying),
  paid: num(row.paid),
});

/** Read-only figures for the lead reports, and the visit counter the public site adds to. */
export class LeadReportRepository {
  /** The agency's settings (for the old website's addresses). */
  async settings(tx: Transaction, agencyId: string): Promise<unknown> {
    const result = await tx.query(`SELECT settings FROM matrimony.agencies WHERE id = $1`, [
      agencyId,
    ]);
    return (result.rows[0] as Row | undefined)?.settings;
  }

  /** One more visit for the day, source and campaign. */
  async addVisit(
    tx: Transaction,
    agencyId: string,
    day: string,
    source: LeadSource,
    campaign: string,
  ) {
    await tx.query(
      `INSERT INTO matrimony.site_visits (agency_id, day, source, campaign, visits)
       VALUES ($1, $2::date, $3, $4, 1)
       ON CONFLICT (agency_id, day, source, campaign) DO UPDATE SET visits = site_visits.visits + 1`,
      [agencyId, day, source, campaign],
    );
  }

  async visits(
    tx: Transaction,
    agencyId: string,
    from: string,
    to: string,
  ): Promise<{ source: LeadSource; campaign: string; visits: number }[]> {
    const result = await tx.query(
      `SELECT source, campaign, sum(visits)::int AS visits FROM matrimony.site_visits
        WHERE agency_id = $1 AND day BETWEEN $2::date AND $3::date
        GROUP BY source, campaign`,
      [agencyId, from, to],
    );
    return (result.rows as Row[]).map((row) => ({
      source: row.source as LeadSource,
      campaign: row.campaign as string,
      visits: num(row.visits),
    }));
  }

  async bySource(
    tx: Transaction,
    agencyId: string,
    from: string,
    to: string,
  ): Promise<(Omit<FunnelCounts, 'visits'> & { source: string })[]> {
    const result = await tx.query(
      `WITH ${LEADS_IN_PERIOD}
       SELECT l.source, ${COUNTS}
         FROM leads l LEFT JOIN paid ON paid.id = l.id
        GROUP BY l.source`,
      [agencyId, from, to],
    );
    return (result.rows as Row[]).map((row) => ({
      source: row.source as string,
      ...toCounts(row),
    }));
  }

  /** Per campaign (staff-made links and other tags), most enquiries first. */
  async byCampaign(
    tx: Transaction,
    agencyId: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<(Omit<FunnelCounts, 'visits'> & { campaign: string; source: LeadSource | null })[]> {
    const result = await tx.query(
      `WITH ${LEADS_IN_PERIOD}
       SELECT l.utm_campaign AS campaign, (array_agg(l.source ORDER BY l.created_at))[1] AS source, ${COUNTS}
         FROM leads l LEFT JOIN paid ON paid.id = l.id
        WHERE l.utm_campaign IS NOT NULL
        GROUP BY l.utm_campaign
        ORDER BY count(*) DESC, l.utm_campaign
        LIMIT $4`,
      [agencyId, from, to, limit],
    );
    return (result.rows as Row[]).map((row) => ({
      campaign: row.campaign as string,
      source: (row.source as LeadSource | null) ?? null,
      ...toCounts(row),
    }));
  }

  /**
   * The payments made in a month ($2 = its first day) by clients who came through an enquiry made on or before the
   * payment's day (the first enquiry linked to the client). Cancelled payments never count.
   */
  async sharedPayments(
    tx: Transaction,
    agencyId: string,
    monthStart: string,
  ): Promise<SharedPayment[]> {
    const result = await tx.query(
      `WITH first_lead AS (
         SELECT DISTINCT ON (client_profile_id) client_profile_id, reference, source, utm_campaign, created_at
           FROM matrimony.website_leads
          WHERE agency_id = $1 AND client_profile_id IS NOT NULL
          ORDER BY client_profile_id, created_at, id)
       SELECT p.id, p.paid_on::text AS paid_on, p.amount, p.stage, p.method, m.id AS profile_id, m.member_code,
              m.full_name, m.created_at AS profile_created_at, f.reference, f.source, f.utm_campaign,
              f.created_at AS lead_created_at
         FROM matrimony.client_payments p
         JOIN first_lead f ON f.client_profile_id = p.profile_id
         JOIN matrimony.member_profiles m ON m.agency_id = p.agency_id AND m.id = p.profile_id
        WHERE p.agency_id = $1 AND p.voided_at IS NULL
          AND p.paid_on >= $2::date AND p.paid_on < ($2::date + interval '1 month')
          AND p.paid_on >= ${BD_DAY('f.created_at')}
        ORDER BY p.paid_on, p.created_at, p.id
        LIMIT 2000`,
      [agencyId, monthStart],
    );
    return (result.rows as Row[]).map((row) => ({
      id: row.id as string,
      paidOn: row.paid_on as string,
      amount: num(row.amount),
      stage: row.stage as string,
      method: (row.method as string | null) ?? null,
      client: {
        profileId: row.profile_id as string,
        memberCode: row.member_code as string,
        name: (row.full_name as string | null) ?? null,
      },
      lead: {
        reference: (row.reference as string | null) ?? null,
        source: (row.source as LeadSource | null) ?? null,
        campaign: (row.utm_campaign as string | null) ?? null,
        createdAt: (row.lead_created_at as Date).toISOString(),
      },
      clientBeforeLead: (row.profile_created_at as Date) < (row.lead_created_at as Date),
    }));
  }
}
