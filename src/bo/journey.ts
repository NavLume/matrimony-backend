/**
 * A client's journey (21 October 2026): one page that shows, with dates, what the agency has done for the client
 * and what each side is waiting for, so nobody has to wonder whether anyone is working on the case. It reads what
 * the platform already records (reviews, verification, assignments, released candidates, proposals, meetings,
 * matches, the terms of the service). Nothing here is new data about anyone else: another person is shown by
 * member code until they accepted a proposal, and by name after, the same rule as everywhere else. Staff see
 * names.
 */
export const JOURNEY_EVENT_KINDS = [
  'profile_submitted',
  'profile_approved',
  'profile_rejected',
  'verification_sent',
  'verification_approved',
  'verification_rejected',
  'agent_assigned',
  'candidates_released',
  'proposal_sent',
  'proposal_forwarded',
  'proposal_not_forwarded',
  'proposal_declined_by_them',
  'proposal_received',
  'proposal_declined_by_me',
  'proposal_accepted',
  'proposal_withdrawn',
  'contact_shared_by_me',
  'contact_shared_by_them',
  'meeting_scheduled',
  'meeting_done',
  'matched',
  'unmatched',
  'terms_recorded',
  'terms_confirmed',
] as const;
export type JourneyEventKind = (typeof JOURNEY_EVENT_KINDS)[number];

export interface JourneyPerson {
  memberCode: string;
  /** Null until the person accepted a proposal (and always shown to staff). */
  fullName: string | null;
}

export interface JourneyEvent {
  at: string;
  kind: JourneyEventKind;
  /** The other person, for a line that is about one. */
  with: JourneyPerson | null;
  /** How many, for released candidates. */
  count: number | null;
  /** An extra word: the agent's name for an assignment, the kind of a meeting. */
  detail: string | null;
}

export const WAIT_KINDS = [
  'profile_review',
  'verification',
  'proposal_review',
  'meeting_outcome',
  'answer_request',
  'confirm_terms',
  'their_answer',
] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export interface JourneyWait {
  kind: WaitKind;
  /** Since when it has been waiting. */
  since: string;
  with: JourneyPerson | null;
}

export interface Journey {
  profile: { id: string; memberCode: string; fullName: string; status: string };
  summary: {
    released: number;
    proposalsSent: number;
    proposalsReceived: number;
    accepted: number;
    meetings: number;
  };
  /** What each side owes. The agency's list is what a client is entitled to see answered. */
  waiting: {
    onAgency: JourneyWait[];
    onYou: JourneyWait[];
    onOthers: JourneyWait[];
  };
  /** Newest first, at most `JOURNEY_LIMIT`. */
  events: JourneyEvent[];
}

export const JOURNEY_LIMIT = 150;
