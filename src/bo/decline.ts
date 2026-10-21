import { z } from 'zod';

/**
 * Why someone said no (21 October 2026): when a proposal is declined, and when a client is not interested after a
 * meeting. A short pick-list instead of free text, so the reasons can be counted and compared. The reason is
 * optional, and private to the agency: the other family never sees it, and the agent uses it to tighten the
 * candidates they release (see DeclinePatterns).
 */
const fail = (key: string) => ({ error: key });

export const DECLINE_REASONS = [
  'religion',
  'age',
  'location',
  'education_work',
  'family',
  'no_chemistry',
  'not_ready',
  'other',
  /** The person chose not to say. Different from no reason recorded at all. */
  'prefer_not_to_say',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export const declineReasonSchema = z.enum(DECLINE_REASONS, fail('invalidOption'));

/** What a client's no's were about: one row per reason, with how many came from proposals and from meetings. */
export interface DeclinePatternItem {
  /** A pick-list reason, or `not_given` when none was recorded. */
  reason: DeclineReason | 'not_given';
  proposals: number;
  meetings: number;
}
export interface DeclinePatterns {
  /** All no's counted: proposals declined by the client plus meetings after which they were not interested. */
  total: number;
  items: DeclinePatternItem[];
}
