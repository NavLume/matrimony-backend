import { z } from 'zod';

/**
 * The terms of a client's service (21 October 2026): what the fee covers, how many introductions are promised
 * (optional) and the refund rule, recorded by the agent or an admin, and confirmed by the client. A change is
 * a new version and clears the confirmation; earlier versions are kept as they were.
 */
const fail = (key: string) => ({ error: key });

const text = (min: number, max: number) =>
  z.string(fail('required')).trim().min(min, fail('tooShort')).max(max, fail('tooLong'));

export const serviceTermsInputSchema = z
  .object({
    coverage: text(3, 2000),
    introductions: z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(1000, fail('outOfRange'))
      .nullable()
      .default(null),
    refundRule: text(3, 1000),
  })
  .strict();
export type ServiceTermsInput = z.output<typeof serviceTermsInputSchema>;

export interface ServiceTerms {
  version: number;
  coverage: string;
  /** How many introductions are promised, or null when no number is promised. */
  introductions: number | null;
  refundRule: string;
  /** Who recorded it and when. */
  recordedBy: string;
  recordedAt: string;
  /** The confirmation: when, by whom, and how (the client in the app, or the agent in the office). */
  acknowledged: { at: string; by: string; how: 'client' | 'office' } | null;
}

export interface ServiceTermsState {
  profile: { id: string; memberCode: string; fullName: string };
  /** The newest version, or null when none is recorded yet. */
  current: ServiceTerms | null;
  /** Every version, newest first. Staff only; a client gets an empty list. */
  history: ServiceTerms[];
}
