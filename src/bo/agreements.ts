import { z } from 'zod';

/**
 * Agreeing to the current terms and privacy policy again (decided with the owner on 20 October 2026). When
 * an agency publishes a new version of either text, the members and guardians who agreed to an earlier one
 * must agree to the current one before they can go on. Staff are not asked: they work for the agency.
 * Until they agree, every call except reading and accepting the agreements is refused with
 * `AGREEMENT_REQUIRED`.
 */
const fail = (key: string) => ({ error: key });

/** The roles that agree to the texts: people who registered or were invited as a member or a guardian. */
export const AGREEMENT_ROLES = ['member', 'guardian'] as const;

export const acceptAgreementsSchema = z
  .object({
    acceptTerms: z.literal(true, fail('required')),
    acceptPrivacy: z.literal(true, fail('required')),
  })
  .strict();

export interface AgreementsStatus {
  /** True when the person must agree before going on. */
  required: boolean;
  /** The version the agency shows now, and the one this person last agreed to (null if none). */
  terms: { current: string; accepted: string | null };
  privacy: { current: string; accepted: string | null };
}
