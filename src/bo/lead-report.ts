import { z } from 'zod';
import { LEAD_SOURCES, type LeadSource } from './consultation.js';

/**
 * Lead reports (21 November 2026, phase C of the acquisition flow).
 *
 * - The funnel by source: visits (counted, no person stored) → enquiries → number proved → called → became a client →
 *   paid, and the money paid, for enquiries made in a period. A source with no visits recorded still shows its
 *   enquiries (visits were only counted from this date).
 * - The monthly revenue share (the deal with the agency's CEO, told by the owner on 21 November 2026): every payment
 *   recorded in the month by a client who came through a website enquiry made before the payment, and the platform's
 *   share of the total. Open questions are not decided here, only shown: a client who was there before the enquiry is
 *   flagged, refunds are not handled (a cancelled payment is never counted), and the share is taken from the full
 *   amount recorded.
 */
const fail = (key: string) => ({ error: key });

/** The platform's share of a counted payment, in per cent (the agreement of 21 November 2026). */
export const PLATFORM_SHARE_PERCENT = 30;

const day = z.iso.date(fail('invalid'));

export const leadFunnelQuerySchema = z
  .object({ from: day.optional(), to: day.optional() })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, fail('invalid'));

export const revenueShareQuerySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, fail('invalid'))
      .optional(),
  })
  .strict();

/** A visit the browser reports: the same origin fields an enquiry carries. */
export const visitInputSchema = z.object({ origin: z.unknown() }).strict();

export interface FunnelCounts {
  visits: number;
  leads: number;
  verified: number;
  contacted: number;
  clients: number;
  paying: number;
  /** Whole taka paid by those clients after their enquiry (cancelled payments never count). */
  paid: number;
}

export interface LeadFunnel {
  from: string;
  to: string;
  total: FunnelCounts;
  bySource: (FunnelCounts & { source: LeadSource })[];
  /** Staff-made links (and any tagged campaign), most enquiries first, at most 30. */
  byCampaign: (FunnelCounts & { campaign: string; source: LeadSource | null })[];
}

export interface SharedPayment {
  id: string;
  paidOn: string;
  amount: number;
  stage: string;
  method: string | null;
  client: { profileId: string; memberCode: string; name: string | null };
  lead: {
    reference: string | null;
    source: LeadSource | null;
    campaign: string | null;
    createdAt: string;
  };
  /** The client's profile existed before the enquiry (an open question with the agency). */
  clientBeforeLead: boolean;
}

export interface RevenueShare {
  month: string;
  percent: number;
  payments: SharedPayment[];
  total: number;
  /** The platform's share, rounded to whole taka. */
  share: number;
  /** What stays with the agency. */
  agency: number;
  /** Payments by clients who were there before their enquiry (included above, listed for the talk with the agency). */
  clientBeforeLeadTotal: number;
}

export const emptyCounts = (): FunnelCounts => ({
  visits: 0,
  leads: 0,
  verified: 0,
  contacted: 0,
  clients: 0,
  paying: 0,
  paid: 0,
});

/** Every source in the fixed order, with zeros where nothing was recorded, and the total. */
export function bySourceOf(rows: (Partial<FunnelCounts> & { source: string })[]) {
  const bySource = LEAD_SOURCES.map((source) => {
    const counts = emptyCounts();
    for (const row of rows.filter((r) => r.source === source))
      for (const key of Object.keys(counts) as (keyof FunnelCounts)[])
        counts[key] += Number(row[key] ?? 0);
    return { source, ...counts };
  });
  const total = emptyCounts();
  for (const row of bySource)
    for (const key of Object.keys(total) as (keyof FunnelCounts)[]) total[key] += row[key];
  return { bySource, total };
}

/** The share of a total in whole taka (rounded half up), and what is left for the agency. */
export function splitShare(total: number, percent = PLATFORM_SHARE_PERCENT) {
  const share = Math.round((total * percent) / 100);
  return { share, agency: total - share };
}
