import { z } from 'zod';

/**
 * The admin's reports (part C of Shammo Bhai's feedback of 16 October 2026): how many people there are,
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

const searchText = z.string().trim().min(1, fail('required')).max(60, fail('tooLong'));

/** A search of the per-client money table, by member (name or code) or agent. */
export const clientMoneyQuerySchema = z.object({ q: searchText.optional() }).strict();

export const cancelledQuerySchema = z
  .object({
    q: searchText.optional(),
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(50, fail('outOfRange'))
      .default(15),
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type CancelledQuery = z.output<typeof cancelledQuerySchema>;

export const successfulQuerySchema = z
  .object({
    q: searchText.optional(),
    /** `true`: only connections where a client is marked matched; `false`: only those not yet matched. */
    matched: z.enum(['true', 'false'], fail('invalidOption')).optional(),
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(50, fail('outOfRange'))
      .default(15),
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type SuccessfulQuery = z.output<typeof successfulQuerySchema>;

/** A payment that was cancelled, with who cancelled it and why. It never counts in any total. */
export interface CancelledPayment {
  id: string;
  profile: { id: string; memberCode: string; fullName: string };
  agentName: string | null;
  stage: 'registration' | 'success';
  amount: number;
  paidOn: string;
  method: string;
  receivedBy: string;
  cancelledAt: string;
  cancelledBy: string;
  reason: string;
  hasInvoice: boolean;
}

export interface CancelledPage {
  items: CancelledPayment[];
  next: string | null;
  /** Everything ever cancelled, whatever the search. */
  totals: { count: number; amount: number };
}

/** One client of a successful connection, with what they agreed and paid, all time. */
export interface SuccessSide {
  profileId: string;
  memberCode: string;
  fullName: string;
  status: string;
  agentName: string | null;
  verified: boolean;
  registration: { agreed: number; paid: number };
  success: { agreed: number; paid: number };
}

/** An accepted proposal with everything known about it: dates, meetings and money. */
export interface SuccessfulConnection {
  id: string;
  sentAt: string;
  connectedAt: string;
  daysToAccept: number;
  a: SuccessSide;
  b: SuccessSide;
  contactShared: { a: boolean; b: boolean };
  /** At least one of the two clients is marked matched. */
  matched: boolean;
  /** When the connection itself was marked matched (the matched step), if it was. */
  matchedAt: string | null;
  /** The success story of this match: its state and whether both clients agreed. */
  story: {
    id: string;
    status: 'draft' | 'published' | 'hidden';
    consentBoth: boolean;
    removed: boolean;
    /** A couple photo is stored (shown on the site only while the story is published). */
    hasPhoto: boolean;
    /** `YYYY-MM-DD`. */
    weddingDate: string | null;
  } | null;
  meetings: { total: number; done: number; last: string | null };
  /** Success-fee payments recorded for this very connection. */
  successFeeForThis: number;
  /** What both clients paid, all stages, all time. */
  bothPaid: number;
  bothAgreed: number;
}

export interface SuccessfulPage {
  items: SuccessfulConnection[];
  next: string | null;
  /** Over all accepted connections, whatever the search. */
  totals: { connections: number; matched: number; successFeeCollected: number };
}
