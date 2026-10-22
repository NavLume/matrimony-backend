import { z } from 'zod';

/**
 * The introduction ledger (22 October 2026): who introduced whom, and who did what, for each proposal.
 *
 * It is a record, not a rule. It does not decide who earned a success fee, or how credit is shared: each agency's
 * admin decides that (the first introducer, a 50/50 split, each agent for their own client), and this gives them
 * dated facts to decide from. Nothing new is written for it: it is read from what the platform already stores
 * (when an agent released a candidate to a client, who sent, approved and answered the request, who arranged each
 * meeting, who recorded the match, and who looked after each client), so it also covers every earlier proposal.
 */
const fail = (key: string) => ({ error: key });

export const HISTORY_KINDS = [
  /** An agent released the other person to the client who then asked. Missing when they found them by code. */
  'suggested',
  'requested',
  'approved',
  'rejected',
  'accepted',
  'declined',
  'meeting',
  'matched',
  'unmatched',
  /** A client changed hands, so a different agent looked after one side from then on. */
  'handed_over',
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistoryActor {
  name: string;
  role: 'admin' | 'agent' | 'member' | 'guardian';
}

export interface HistoryEvent {
  kind: HistoryKind;
  at: string;
  /** Who did it. Null for the platform's own steps and for an account that no longer exists. */
  by: HistoryActor | null;
  /** The member code of the client it was about, when it was about one side. */
  aboutMemberCode: string | null;
  /** The new agent, for a handover; the meeting's kind and state, for a meeting. */
  detail: string | null;
}

export interface ConnectionHistory {
  connectionId: string;
  sides: { memberCode: string; fullName: string; agent: string | null }[];
  /** Oldest first. */
  events: HistoryEvent[];
}

/** One agent's introductions, counted over a range of dates. */
export interface AgentIntroductions {
  agentId: string;
  name: string;
  role: 'admin' | 'agent';
  /** Candidates this person released to a client. */
  suggested: number;
  /** Of those, how many the client then asked. */
  ledToRequest: number;
  /** Of those, how many were accepted. */
  ledToAccepted: number;
  /** Of those, how many are a match now. */
  ledToMatch: number;
  /** Requests this person approved, and rejected, in review. */
  approved: number;
  rejected: number;
  meetingsArranged: number;
  matchesRecorded: number;
}

export const introductionRangeSchema = z
  .object({
    from: z
      .string(fail('invalid'))
      .regex(/^\d{4}-\d{2}-\d{2}$/, fail('invalid'))
      .optional(),
    to: z
      .string(fail('invalid'))
      .regex(/^\d{4}-\d{2}-\d{2}$/, fail('invalid'))
      .optional(),
  })
  .strict();
export type IntroductionRange = z.output<typeof introductionRangeSchema>;
