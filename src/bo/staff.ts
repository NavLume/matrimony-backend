import { z } from 'zod';
import { emailSchema, newPasswordSchema, oneTimeTokenSchema } from './credentials.js';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * Inviting staff. Only an admin invites, as an agent or as another admin. The person chooses their
 * own password when they accept, so no password ever travels with the invitation.
 *
 * Validation messages are stable keys, as elsewhere, so the frontend can translate them.
 */
const fail = (key: string) => ({ error: key });

export const STAFF_ROLES = ['agent', 'admin'] as const;
/** How long an invitation works. The email states these days, so change both together. */
export const INVITATION_DAYS = 7;

export const staffInviteInputSchema = z
  .object({
    email: emailSchema,
    displayName: z
      .string(fail('required'))
      .trim()
      .min(1, fail('required'))
      .max(100, fail('tooLong')),
    role: z.enum(STAFF_ROLES, fail('invalidOption')),
    /** The language of the email and of the page its link opens. */
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
  })
  .strict();
export type StaffInviteInput = z.output<typeof staffInviteInputSchema>;

/**
 * An admin creates a staff account directly, choosing its first password. The person is then told
 * the password by the admin and can change it with "Forgot your password". Prefer an invitation,
 * which lets the person choose their own.
 */
export const staffCreateInputSchema = z
  .object({
    email: emailSchema,
    displayName: z
      .string(fail('required'))
      .trim()
      .min(1, fail('required'))
      .max(100, fail('tooLong')),
    role: z.enum(STAFF_ROLES, fail('invalidOption')),
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
    password: newPasswordSchema,
  })
  .strict();
export type StaffCreateInput = z.output<typeof staffCreateInputSchema>;

export const invitationLinkInputSchema = z.object({ token: oneTimeTokenSchema }).strict();

export const acceptInvitationInputSchema = z
  .object({ token: oneTimeTokenSchema, password: newPasswordSchema })
  .strict();
export type AcceptInvitationInput = z.output<typeof acceptInvitationInputSchema>;

/** An invitation as the admin sees it. `expired` is an open invitation whose link no longer works. */
export interface StaffInvitation {
  id: string;
  email: string;
  displayName: string;
  role: (typeof STAFF_ROLES)[number];
  locale: 'bn' | 'en';
  /** The display name of the admin who invited. */
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'expired';
}

/** What the person who opens the link is shown before choosing a password. */
export interface InvitationPreview {
  email: string;
  displayName: string;
  role: (typeof STAFF_ROLES)[number];
}
