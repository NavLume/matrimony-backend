import { z } from 'zod';
import { emailSchema, newPasswordSchema, oneTimeTokenSchema } from './credentials.js';
import { phoneSchema } from './phone-number.js';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * A login for a client the agency runs. The agent sends a one-time link by text message or email;
 * the client chooses their own password and accepts the terms. No password ever travels with the
 * link and the agent never learns it.
 *
 * Validation messages are stable keys, as elsewhere, so the frontend can translate them.
 */
const fail = (key: string) => ({ error: key });

/** How long the link works. The message states these days, so change both together. */
export const CLIENT_LOGIN_DAYS = 7;

export const clientLoginGrantSchema = z.discriminatedUnion('channel', [
  z
    .object({
      channel: z.literal('sms'),
      phone: phoneSchema,
      locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
    })
    .strict(),
  z
    .object({
      channel: z.literal('email'),
      email: emailSchema,
      locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
    })
    .strict(),
]);
export type ClientLoginGrant = z.output<typeof clientLoginGrantSchema>;

export const clientLoginLinkSchema = z.object({ token: oneTimeTokenSchema }).strict();

export const clientLoginAcceptSchema = z
  .object({
    token: oneTimeTokenSchema,
    password: newPasswordSchema,
    acceptTerms: z.literal(true, fail('required')),
    acceptPrivacy: z.literal(true, fail('required')),
  })
  .strict();
export type ClientLoginAccept = z.output<typeof clientLoginAcceptSchema>;

/**
 * Where a client's login stands, for the staff who look after them.
 * - `none`: no account and no link. `invited`: a link is out. `expired`: it was not used in time.
 * - `active`: the client has an account.
 * `canGrant` says whether this client can be given a login at all: it needs a client with no
 * account, which the agency runs.
 */
export interface ClientLoginStatus {
  state: 'none' | 'invited' | 'expired' | 'active';
  canGrant: boolean;
  channel: 'sms' | 'email' | null;
  address: string | null;
  locale: 'bn' | 'en' | null;
  expiresAt: string | null;
  invitedByName: string | null;
  /** The display name of the client's account, once it exists. */
  accountName: string | null;
}

/** What the person who opens the link is shown before choosing a password. */
export interface ClientLoginPreview {
  displayName: string;
  channel: 'sms' | 'email';
  locale: 'bn' | 'en';
}
