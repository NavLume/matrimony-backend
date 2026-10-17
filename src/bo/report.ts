import { z } from 'zod';

/**
 * The admin's reports (part C of the friend's feedback of 16 October 2026): how many people there are,
 * how proposals are going, who is connected with whom, how each agent is doing, and the money recorded
 * in the office. Read only, and for admins only.
 *
 * Years are the agency's financial year, July to June, named by the year it starts in (2026 means July
 * 2026 to June 2027), with a switch for the calendar year. Months are Bangladesh time.
 */
const fail = (key: string) => ({ error: key });

export const REPORT_BASES = ['fiscal', 'calendar'] as const;
export type ReportBasis = (typeof REPORT_BASES)[number];

export const summaryQuerySchema = z
  .object({
    basis: z.enum(REPORT_BASES, fail('invalidOption')).default('fiscal'),
    year: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(2000, fail('outOfRange'))
      .max(2100, fail('outOfRange'))
      .optional(),
  })
  .strict();
export type SummaryQuery = z.output<typeof summaryQuerySchema>;

export const PROPOSAL_STATUSES = [
  'in_review',
  'pending',
  'accepted',
  'declined',
  'withdrawn',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const proposalListQuerySchema = z
  .object({
    status: z.enum(PROPOSAL_STATUSES, fail('invalidOption')).optional(),
    q: z.string().trim().min(1, fail('required')).max(60, fail('tooLong')).optional(),
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(50, fail('outOfRange'))
      .default(20),
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type ProposalListQuery = z.output<typeof proposalListQuerySchema>;

export const networkQuerySchema = z.object({ client: z.uuid(fail('invalid')).optional() }).strict();

export interface ReportMonth {
  month: string;
  registrations: number;
  proposals: number;
  accepted: number;
}

export interface AgentReport {
  id: string;
  name: string;
  role: 'admin' | 'agent';
  clients: number;
  activeClients: number;
  matchedClients: number;
  requestsReviewed: number;
  /** Average hours a request waited for this person's review. Null when none was reviewed. */
  averageReviewHours: number | null;
  waitingForReview: number;
  /** Collected in the chosen year, from payments that are not cancelled. */
  collected: number;
}

export interface ClientMoney {
  profileId: string;
  memberCode: string;
  fullName: string;
  agentName: string | null;
  agreed: number;
  paid: number;
}

export interface SummaryReport {
  basis: ReportBasis;
  /** The year the figures for money are for (the year it starts in). */
  year: number;
  years: number[];
  people: {
    members: number;
    clients: number;
    assistedClients: number;
    agents: number;
    admins: number;
    profilesByStatus: Record<string, number>;
  };
  waiting: { profileReviews: number; proposalReviews: number; cvs: number };
  proposals: {
    total: number;
    byStatus: Record<ProposalStatus, number>;
    contactShared: number;
    bothShared: number;
  };
  funnel: { made: number; accepted: number; contactShared: number; matchedClients: number };
  months: ReportMonth[];
  agents: AgentReport[];
  money: {
    yearly: { year: number; total: number }[];
    monthly: { month: string; registration: number; success: number }[];
    yearTotals: { registration: number; success: number };
    agreedTotal: number;
    paidTotal: number;
    clients: ClientMoney[];
  };
}

export interface ProposalSide {
  profileId: string;
  memberCode: string;
  fullName: string;
  gender: string | null;
  agentName: string | null;
}

export interface ProposalRow {
  id: string;
  status: ProposalStatus;
  createdAt: string;
  respondedAt: string | null;
  from: ProposalSide;
  to: ProposalSide;
  fromSharedContact: boolean;
  toSharedContact: boolean;
}

export interface ProposalPage {
  items: ProposalRow[];
  next: string | null;
  /** Position of the last item, for the cursor. */
  lastPosition?: string;
}

export interface NetworkNode {
  profileId: string;
  memberCode: string;
  fullName: string;
  gender: string | null;
}

export interface NetworkEdge {
  id: string;
  from: string;
  to: string;
  status: ProposalStatus;
}

export interface NetworkReport {
  /** The client at the centre, or null for the agency-wide view of accepted proposals. */
  centre: string | null;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** More accepted proposals exist than are drawn. */
  truncated: boolean;
}
