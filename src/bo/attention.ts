/**
 * What has waited too long (21 October 2026). Reply discipline is the one lever that works against silence in
 * matchmaking, and the agent is the bottleneck, so the agenda lists, for each agent and for the admin, the
 * things that have waited past a limit, oldest first, with who they are about:
 *
 * - `review_waiting`     a profile, photo, CV or identity document waiting for a decision
 * - `request_in_review`  a request waiting for the agent of the person asked to approve it
 * - `request_unanswered` an approved request the person asked has not answered
 * - `no_candidates`      a published client with an agent and still no profile released
 * - `no_meeting`         an accepted request with no meeting arranged and no match recorded
 *
 * (Meetings without an outcome and follow-ups past their date are already on the agenda.) An agent sees the
 * clients assigned to them; an admin sees everyone and a workload line for each agent.
 */
export const ATTENTION_KINDS = [
  'review_waiting',
  'request_in_review',
  'request_unanswered',
  'no_candidates',
  'no_meeting',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

// The days after which each kind counts as overdue are the agency's own settings (see bo/agency-settings.ts).

export interface AttentionPerson {
  memberCode: string;
  fullName: string;
}

export interface AttentionItem {
  kind: AttentionKind;
  /** Since when it has waited. */
  since: string;
  /** The client it is about (the person asked, for a request). */
  client: { id: string; memberCode: string; fullName: string };
  /** The other person, for a request or an accepted proposal. */
  with: AttentionPerson | null;
  /** The agent who looks after the client, or null. */
  agent: { id: string; displayName: string } | null;
}

export interface Workload {
  agentId: string;
  displayName: string;
  /** Published clients they look after. */
  clients: number;
  /** Overdue items about those clients. */
  overdue: number;
  /** Whole days the oldest overdue item has waited, or null when there is none. */
  oldestDays: number | null;
}

export interface Attention {
  items: AttentionItem[];
  /** For an admin: one line per agent. Empty for an agent. */
  workload: Workload[];
}
