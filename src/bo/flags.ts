import { z } from 'zod';

/**
 * Fraud signals (22 October 2026): warning flags that help staff notice a suspicious profile early. They are hints
 * for a person to check, never verdicts. Decided with the owner: a flag only informs staff (it never pauses or blocks
 * a profile), and the member never sees it. See migration 058.
 *
 * What is looked for, from what the platform already holds (chat is private until reported, so it is never read):
 *   shared_phone / shared_email  the same number or address on profiles of different people
 *   shared_photo                 the same picture (an exact copy) on profiles of different people
 *   request_burst                many proposals sent within a day
 *   reported_by_several          reports about the profile from at least two different people in 90 days
 *   document_rejected_twice      an identity document rejected at least twice
 * A staff member marks a flag checked and fine, or confirmed as a problem; it returns only if new evidence appears.
 */
const fail = (key: string) => ({ error: key });

export const SIGNALS = [
  'shared_phone',
  'shared_email',
  'shared_photo',
  'request_burst',
  'reported_by_several',
  'document_rejected_twice',
] as const;
export type Signal = (typeof SIGNALS)[number];

/** How much counts as a burst, and how many reporters or rejections count as several. */
export const BURST_REQUESTS = 10;
export const BURST_HOURS = 24;
export const REPORTERS = 2;
export const REPORT_DAYS = 90;
export const REJECTED_DOCUMENTS = 2;

export const FLAG_STATES = ['open', 'reviewed'] as const;
export type FlagState = (typeof FLAG_STATES)[number];

export const flagListQuerySchema = z
  .object({ state: z.enum(FLAG_STATES, fail('invalidOption')).default('open') })
  .strict();

export const flagReviewSchema = z
  .object({ outcome: z.enum(['fine', 'confirmed'], fail('invalidOption')) })
  .strict();
export type FlagOutcome = z.output<typeof flagReviewSchema>['outcome'];

export const signalParamSchema = z.enum(SIGNALS, fail('invalidOption'));

export interface FlagRow {
  profileId: string;
  memberCode: string;
  fullName: string;
  signal: Signal;
  /** The member codes of the other profiles it matches (shared phone, email or photo); empty for the others. */
  others: string[];
  /** How many: other profiles, requests, reporters or rejections. */
  count: number;
  /** When the newest evidence appeared. */
  evidenceAt: string;
  /** open, or what a staff member decided about it. */
  status: 'open' | FlagOutcome;
  reviewedBy: string | null;
  reviewedAt: string | null;
}
