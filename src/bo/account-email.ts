import { z } from 'zod';
import { emailSchema, newPasswordSchema } from './credentials.js';
import { phoneCodeSchema } from './phone.js';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * Adding an email to an account that has none, and choosing a new password while signed in. No text message is used
 * (owner decision, 27 Nov 2026): adding an email is proved by the account's password and a 6-digit code sent to the new
 * address; a new password by a code sent to the account's own email. Which account always comes from the session.
 */
const fail = (key: string) => ({ error: key });

/** Asking for the code (to the account's own email) that proves it is the owner before a new password. */
export const reauthStartInputSchema = z
  .object({ locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')) })
  .strict();

/** Step one of adding an email: the address, and the account's password to prove it is the owner. */
export const addEmailStartInputSchema = z
  .object({
    email: emailSchema,
    password: z.string(fail('required')).min(1, fail('required')).max(200, fail('tooLong')),
    /** The language of the email. */
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
  })
  .strict();
export type AddEmailStartInput = z.output<typeof addEmailStartInputSchema>;

/** Step two: the code that was emailed to the new address. */
export const addEmailCodeInputSchema = z.object({ code: phoneCodeSchema }).strict();

/** What the stored code carries, sealed: which account the address is for, and the address. */
export const pendingAddEmailSchema = z.object({
  accountId: z.uuid(),
  email: z.string().min(1),
});

/** A new password while signed in, proved by the code sent to the account's own email. */
export const changePasswordInputSchema = z
  .object({ code: phoneCodeSchema, password: newPasswordSchema })
  .strict();
export type ChangePasswordInput = z.output<typeof changePasswordInputSchema>;
