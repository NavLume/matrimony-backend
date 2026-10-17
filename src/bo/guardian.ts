import { z } from 'zod';
import { emailSchema, newPasswordSchema, oneTimeTokenSchema } from './credentials.js';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * A guardian for a client (17 October 2026). A parent or relative gets a login of their own to see the
 * client's proposals and give advice.
 *
 * - One guardian per profile, invited by email by the agent who looks after the client (or an admin).
 * - The client must agree first. A client who signs in agrees in the app; for a client with no login
 *   the agent records that the client agreed. Who agreed and when is kept.
 * - A guardian only advises (supportive or concerned, with a short note). Accepting or declining a
 *   proposal stays with the client or their agent.
 * - A guardian sees the same details about other people as the client does, and nothing else: no
 *   chat, no payments, no editing and no sharing of contact details.
 * - The client or the agency can remove the guardian at any time.
 */
const fail = (key: string) => ({ error: key });

/** How long the invitation link works. The message states these days, so change both together. */
export const GUARDIAN_INVITE_DAYS = 7;

export const guardianInviteSchema = z
  .object({
    email: emailSchema,
    displayName: z
      .string(fail('required'))
      .trim()
      .min(1, fail('required'))
      .max(120, fail('tooLong')),
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
    /** For a client with no login: the agent confirms the client agreed. Ignored for a client who signs in. */
    clientAgreed: z.boolean(fail('invalid')).optional(),
  })
  .strict();
export type GuardianInvite = z.output<typeof guardianInviteSchema>;

export const guardianLinkSchema = z.object({ token: oneTimeTokenSchema }).strict();

export const guardianAcceptSchema = z
  .object({
    token: oneTimeTokenSchema,
    password: newPasswordSchema,
    acceptTerms: z.literal(true, fail('required')),
    acceptPrivacy: z.literal(true, fail('required')),
  })
  .strict();
export type GuardianAccept = z.output<typeof guardianAcceptSchema>;

export const ADVICE = ['supportive', 'concerned'] as const;
export type AdviceKind = (typeof ADVICE)[number];

export const adviceInputSchema = z
  .object({
    advice: z.enum(ADVICE, fail('invalidOption')),
    note: z
      .string(fail('invalid'))
      .trim()
      .max(300, fail('tooLong'))
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
  })
  .strict();
export type AdviceInput = z.output<typeof adviceInputSchema>;

/** What a guardian advised about one proposal. */
export interface GuardianAdvice {
  advice: AdviceKind;
  note: string | null;
  at: string;
}

/**
 * Where a profile's guardian stands.
 * - `none`: no guardian. `awaiting_client`: the agent asked and the client has not agreed yet.
 * - `invited`: the link was sent. `expired`: it was not used in time. `active`: the guardian has an account.
 */
export interface GuardianState {
  state: 'none' | 'awaiting_client' | 'invited' | 'expired' | 'active';
  displayName: string | null;
  email: string | null;
  expiresAt: string | null;
  consentBasis: 'client_in_app' | 'agent_recorded' | null;
  consentedAt: string | null;
  /** Whether the client has a login: then their agreement is given in the app. */
  clientHasLogin: boolean;
}

/** What the person who opens the invitation link is shown before choosing a password. */
export interface GuardianPreview {
  displayName: string;
  clientName: string;
  locale: 'bn' | 'en';
}

/** The client a guardian looks after, as the guardian sees them. */
export interface WardSummary {
  profileId: string;
  memberCode: string;
  fullName: string;
}
