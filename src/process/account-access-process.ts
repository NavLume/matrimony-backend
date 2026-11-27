import { randomBytes, randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  pendingAddEmailSchema,
  type AddEmailStartInput,
  type ChangePasswordInput,
} from '../bo/account-email.js';
import type { Account } from '../bo/identity.js';
import { passwordMatchesEmail } from '../bo/credentials.js';
import { platformLegalVersions, type LegalVersionSource } from '../bo/legal.js';
import { toRegistration, registrationSchema, type RegistrationInput } from '../bo/registration.js';
import type { OneTimeTokenRepository } from '../cache/repository/one-time-token-repository.js';
import type { SessionRepository } from '../cache/repository/session-repository.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import { AppError } from '../exception/app-error.js';
import {
  emailCodeEmail,
  emailInUseNotice,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
  type MailLocale,
} from '../mail/messages.js';
import type { Mailer, MailMessage } from '../mail/mailer.js';
import { SecretBox, digest } from '../security/secret-box.js';
import type { AuthProcess } from './auth-process.js';
import { passwordIsPhone, type PhoneAuthProcess } from './phone-auth-process.js';
import type { CredentialService } from '../service/credential-service.js';
import type { RegistrationService } from '../service/registration-service.js';

/** How long an emailed link works. The emails state these hours, so change both together. */
const REGISTRATION_LINK_SECONDS = 24 * 3600;
const RESET_LINK_SECONDS = 3600;
/** Emails one address can be sent per hour for each purpose, whether or not it has an account. */
const EMAILS_PER_HOUR = 3;
const HOUR = 3600;
/** How long an emailed 6-digit code works. The email states the minutes, so change both together. */
const EMAIL_CODE_SECONDS = 600;
/** Wrong codes one account may type in 10 minutes before it must wait. */
const CODE_TRIES = 5;

/** The agency the request is for, which the emails name and link back to. */
export interface AccessContext {
  agencyId: string;
  agencyName: string;
  /** The address the person's browser used, for example https://marriage.example. */
  origin: string;
}

const pendingRegistrationSchema = z.object({
  email: z.string(),
  passwordHash: z.string(),
  registration: registrationSchema,
});
const resetSchema = z.object({ accountId: z.uuid() });

const newToken = () => randomBytes(32).toString('base64url');
/** The agency is part of what is hashed, so a link only works on the agency that sent it. */
const tokenKey = (agencyId: string, token: string) => digest(`${agencyId}.${token}`);

/**
 * Registering, proving an email address, and getting back into an account.
 *
 * Every step that takes an email address answers the same way whether or not the address has an
 * account, because on a matrimony site "this person is a member" is itself private. What differs
 * goes in the email, which only the owner of the address can read.
 */
export class AccountAccessProcess {
  private readonly sending = new Set<Promise<void>>();

  constructor(
    private readonly registrations: Pick<
      RegistrationService,
      'emailRegistered' | 'createVerified' | 'signInMethods' | 'attachEmail' | 'findByPhone'
    >,
    private readonly credentials: Pick<
      CredentialService,
      'hash' | 'findByEmail' | 'findById' | 'setPassword' | 'verifyAccount'
    >,
    private readonly tokens: Pick<OneTimeTokenRepository, 'put' | 'take'>,
    private readonly throttle: Pick<ThrottleRepository, 'hit'>,
    private readonly sessions: Pick<SessionRepository, 'removeAll'>,
    private readonly auth: Pick<AuthProcess, 'startSession'>,
    private readonly mailer: Mailer,
    private readonly box: SecretBox,
    private readonly logger: Logger,
    /** No longer used: the account's own checks go by email now (kept so the wiring does not change). */
    /** Text-message codes, only for a forgotten password on an account with no email. Undefined when SMS is off. */
    private readonly phone?: Pick<PhoneAuthProcess, 'sendResetCode' | 'checkResetCode'>,
    /** The version of the terms and privacy text the agency shows now, recorded with the person's agreement. */
    private readonly legalVersions: LegalVersionSource = platformLegalVersions,
  ) {}

  /**
   * Called once the registration link is sent, so the person is kept as an enquiry staff can call even if the link is
   * never opened (set in the container). A failure is logged and never fails the registration.
   */
  afterRegistrationStarted?: (context: AccessContext, input: RegistrationInput) => Promise<void>;

  /**
   * Step one of registering. Nothing is created: the answers and the hashed password are kept,
   * sealed, until the person opens the link sent to their email.
   */
  async startRegistration(context: AccessContext, input: RegistrationInput) {
    const scope = `${context.agencyId}:${digest(input.email)}`;
    await this.limitEmails(`register-mail:${scope}`);
    // Always done, so the time taken does not show whether the address is already registered.
    const passwordHash = await this.credentials.hash(input.password);
    const common = { to: input.email, locale: input.locale, agencyName: context.agencyName };

    // The person is told plainly, so they do not wait for an email that will never come. This lets
    // anyone ask whether an address has an account, which the owner accepted for registration; the
    // rate limit on this route and the sign-in answers (which stay the same for every failure) are
    // what keep it from being a tool for scanning.
    if (await this.registrations.emailRegistered(context.agencyId, input.email)) {
      throw new AppError(409, 'EMAIL_ALREADY_REGISTERED');
    }

    const token = newToken();
    const key = tokenKey(context.agencyId, token);
    const pending = {
      email: input.email,
      passwordHash,
      registration: toRegistration(input, await this.legalVersions(context.agencyId)),
    };
    await this.tokens.put(
      'registration',
      scope,
      key,
      this.box.seal(JSON.stringify(pending), key),
      REGISTRATION_LINK_SECONDS,
    );
    if (this.afterRegistrationStarted) {
      try {
        await this.afterRegistrationStarted(context, input);
      } catch {
        this.logger.warn(
          { code: 'REGISTRATION_LEAD_FAILED' },
          'Could not keep the registration as an enquiry',
        );
      }
    }
    this.sendInBackground(
      verificationEmail({
        ...common,
        name: input.displayName,
        link: this.link(context, input.locale, 'verify-email', token),
      }),
    );
  }

  /**
   * Step two: the link was opened and confirmed, so the address is proven, the account is created
   * and the person is signed in like after a login. Only the request that creates the account
   * gets a session: if the address already has one (another route, or another link), the link is
   * refused like an used one, so a link can never sign anyone into an account it did not create.
   */
  async verifyEmail(agencyId: string, token: string, correlationId: string) {
    const key = tokenKey(agencyId, token);
    const sealed = await this.tokens.take('registration', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingRegistrationSchema.parse(JSON.parse(this.box.open(sealed, key)));
    const created = await this.registrations.createVerified(agencyId, pending, correlationId);
    if (!created.created) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return this.auth.startSession(agencyId, created.account, correlationId);
  }

  /**
   * Before a new password: a 6-digit code to the account's own email, to prove it is the owner and not someone holding
   * a stolen session. No text message is sent (owner decision, 27 Nov 2026). 409 EMAIL_REQUIRED without an email.
   */
  async sendReauthCode(context: AccessContext, account: Account, locale: 'bn' | 'en') {
    const methods = await this.registrations.signInMethods(context.agencyId, account.id);
    if (!methods?.email) throw new AppError(409, 'EMAIL_REQUIRED');
    await this.limitEmails(`password-code-mail:${context.agencyId}:${account.id}`);
    const code = await this.newCode(context.agencyId, 'email-code-password', {
      accountId: account.id,
      email: methods.email,
    });
    this.sendInBackground(
      emailCodeEmail({
        to: methods.email,
        locale,
        agencyName: context.agencyName,
        code,
        purpose: 'password',
      }),
    );
    return { resendAfter: 60, expiresIn: EMAIL_CODE_SECONDS };
  }

  /**
   * Step one of adding an email to an account that has none: the account's password proves it is the owner, then a
   * 6-digit code goes to the new address. Nothing is added yet. The answer is the same whether or not the address
   * already belongs to an account; that account's owner is told by email instead.
   */
  async startAddEmail(context: AccessContext, account: Account, input: AddEmailStartInput) {
    const methods = await this.registrations.signInMethods(context.agencyId, account.id);
    if (methods?.email) throw new AppError(409, 'EMAIL_ALREADY_SET');
    await this.credentials.verifyAccount(context.agencyId, account.id, input.password);

    await this.limitEmails(`add-email-mail:${context.agencyId}:${digest(input.email)}`);
    const common = { to: input.email, locale: input.locale, agencyName: context.agencyName };
    if (await this.registrations.emailRegistered(context.agencyId, input.email)) {
      this.sendInBackground(
        emailInUseNotice({ ...common, signInLink: this.link(context, input.locale, 'login') }),
      );
      return;
    }
    const code = await this.newCode(context.agencyId, 'email-code-add', {
      accountId: account.id,
      email: input.email,
    });
    this.sendInBackground(emailCodeEmail({ ...common, code, purpose: 'add_email' }));
  }

  /** Step two: the code from the new address's inbox. The address is then proven and added to the account. */
  async confirmAddEmailCode(
    agencyId: string,
    account: Account,
    code: string,
    correlationId: string,
  ) {
    const pending = await this.takeCode(agencyId, 'email-code-add', account.id, code);
    const result = await this.registrations.attachEmail(
      agencyId,
      pending.accountId,
      pending.email,
      correlationId,
    );
    if (result === 'taken') throw new AppError(409, 'EMAIL_IN_USE');
    if (result === 'unavailable') throw new AppError(409, 'EMAIL_ALREADY_SET');
  }

  /**
   * An older emailed link to add an address (sent before codes replaced links). It still works until it expires.
   * It signs nobody in.
   */
  async confirmAddEmail(agencyId: string, token: string, correlationId: string) {
    const key = tokenKey(agencyId, token);
    const sealed = await this.tokens.take('email-add', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingAddEmailSchema.parse(JSON.parse(this.box.open(sealed, key)));
    const result = await this.registrations.attachEmail(
      agencyId,
      pending.accountId,
      pending.email,
      correlationId,
    );
    if (result === 'taken') throw new AppError(409, 'EMAIL_IN_USE');
    if (result === 'unavailable') throw new AppError(409, 'EMAIL_ALREADY_SET');
  }

  /**
   * Sets a new password for the signed-in account, proved by the code sent to its own email. Every session of the
   * account ends, as for any password reset, and the owner is told by email.
   */
  async changePassword(
    context: AccessContext,
    account: Account,
    input: ChangePasswordInput,
    correlationId: string,
  ) {
    const methods = await this.registrations.signInMethods(context.agencyId, account.id);
    if (!methods?.email) throw new AppError(409, 'EMAIL_REQUIRED');
    // A password that is the email or the number is among the first things guessed.
    const same = passwordMatchesEmail(input.password, methods.email);
    if (same || (methods.phone && passwordIsPhone(input.password, methods.phone)))
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'password', code: same ? 'sameAsEmail' : 'sameAsPhone' }],
      });
    await this.takeCode(context.agencyId, 'email-code-password', account.id, input.code);

    const hash = await this.credentials.hash(input.password);
    if (!(await this.credentials.setPassword(context.agencyId, account.id, hash, correlationId)))
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
    await this.sessions.removeAll(account.id);
    const locale = (await this.credentials.findById(context.agencyId, account.id))?.locale ?? 'en';
    this.sendInBackground(
      passwordChangedEmail({
        to: methods.email,
        locale,
        agencyName: context.agencyName,
        resetLink: this.link(context, locale, 'forgot-password'),
      }),
    );
  }

  /**
   * Stores a new 6-digit code for one account and purpose, sealed with what it is for, and returns it to be emailed.
   * Asking again cancels the earlier code. Only a hash of the code (with the agency and account) is the key.
   */
  private async newCode(
    agencyId: string,
    purpose: 'email-code-add' | 'email-code-password',
    payload: { accountId: string; email: string },
  ): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const key = tokenKey(agencyId, `${purpose}.${payload.accountId}.${code}`);
    await this.tokens.put(
      purpose,
      payload.accountId,
      key,
      this.box.seal(JSON.stringify(payload), key),
      EMAIL_CODE_SECONDS,
    );
    return code;
  }

  /** Uses up a right code; a wrong one is counted, and after a few the account must wait. */
  private async takeCode(
    agencyId: string,
    purpose: 'email-code-add' | 'email-code-password',
    accountId: string,
    code: string,
  ) {
    const tries = await this.throttle.hit(`email-code-try:${agencyId}:${accountId}`, 600);
    if (tries.count > CODE_TRIES)
      throw new AppError(429, 'CODE_RATE_LIMITED', { retryAfter: tries.retryAfter });
    const key = tokenKey(agencyId, `${purpose}.${accountId}.${code}`);
    const sealed = await this.tokens.take(purpose, key);
    if (!sealed) throw new AppError(400, 'CODE_INVALID');
    const pending = pendingAddEmailSchema.parse(JSON.parse(this.box.open(sealed, key)));
    // The code belongs to this account only.
    if (pending.accountId !== accountId) throw new AppError(400, 'CODE_INVALID');
    return pending;
  }

  /**
   * A forgotten password on an account that has no email (registered by phone): a code to its mobile number. Only for
   * a registered number of an active account with no email, so the page cannot be used to make the agency pay for texts
   * to strangers. Like the login page's old code, this tells the visitor whether a number is registered (404
   * PHONE_NOT_REGISTERED), a trade-off the owner accepted; an account with an email is told to use it (409 USE_EMAIL).
   */
  async requestPhoneReset(context: AccessContext, phone: string, locale: 'bn' | 'en') {
    const sms = this.phone ?? this.noSms();
    const found = await this.registrations.findByPhone(context.agencyId, phone);
    if (!found || found.status !== 'active') throw new AppError(404, 'PHONE_NOT_REGISTERED');
    const methods = await this.registrations.signInMethods(context.agencyId, found.account.id);
    if (methods?.email) throw new AppError(409, 'USE_EMAIL');
    return sms.sendResetCode(
      { agencyId: context.agencyId, agencyName: context.agencyName },
      phone,
      locale,
    );
  }

  /** The code and a new password: sets it, ends every session of the account. */
  async resetPasswordByPhone(
    context: AccessContext,
    input: { phone: string; code: string; password: string },
    correlationId: string,
  ) {
    const sms = this.phone ?? this.noSms();
    if (passwordIsPhone(input.password, input.phone))
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'password', code: 'sameAsPhone' }],
      });
    // The code is checked (and a wrong one counted) before anything about the account is looked at.
    await sms.checkResetCode(context.agencyId, input.phone, input.code);
    const found = await this.registrations.findByPhone(context.agencyId, input.phone);
    if (!found || found.status !== 'active') throw new AppError(400, 'CODE_INVALID');
    const hash = await this.credentials.hash(input.password);
    if (
      !(await this.credentials.setPassword(context.agencyId, found.account.id, hash, correlationId))
    )
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
    // Whoever knew the old password, or held a stolen session, is signed out.
    await this.sessions.removeAll(found.account.id);
  }

  private noSms(): never {
    throw new AppError(404, 'PHONE_NOT_CONFIGURED');
  }

  /** Emails a reset link when the address has an account; either way the answer is the same. */
  async requestPasswordReset(context: AccessContext, email: string) {
    const scope = `${context.agencyId}:${digest(email)}`;
    await this.limitEmails(`reset-mail:${scope}`);
    const found = await this.credentials.findByEmail(context.agencyId, email);
    if (!found || found.status !== 'active') return;

    const token = newToken();
    const key = tokenKey(context.agencyId, token);
    await this.tokens.put(
      'password-reset',
      found.account.id,
      key,
      this.box.seal(JSON.stringify({ accountId: found.account.id }), key),
      RESET_LINK_SECONDS,
    );
    this.sendInBackground(
      passwordResetEmail({
        to: email,
        locale: found.locale,
        agencyName: context.agencyName,
        link: this.link(context, found.locale, 'reset-password', token),
      }),
    );
  }

  /** Sets the new password, ends every session of the account, and tells its owner. */
  async resetPassword(
    context: AccessContext,
    token: string,
    password: string,
    correlationId: string,
  ) {
    const key = tokenKey(context.agencyId, token);
    const sealed = await this.tokens.take('password-reset', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const { accountId } = resetSchema.parse(JSON.parse(this.box.open(sealed, key)));

    const hash = await this.credentials.hash(password);
    if (!(await this.credentials.setPassword(context.agencyId, accountId, hash, correlationId)))
      throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    // Whoever knew the old password, or held a stolen session, is signed out.
    await this.sessions.removeAll(accountId);

    const account = await this.credentials.findById(context.agencyId, accountId);
    if (account?.email) {
      this.sendInBackground(
        passwordChangedEmail({
          to: account.email,
          locale: account.locale,
          agencyName: context.agencyName,
          resetLink: this.link(context, account.locale, 'forgot-password'),
        }),
      );
    }
  }

  /** Resolves when every email handed over so far has been sent or has failed. For shutdown and tests. */
  async idle() {
    await Promise.allSettled([...this.sending]);
  }

  /** 429 once one address has been sent too many emails of one kind, known or unknown alike. */
  private async limitEmails(name: string) {
    const hits = await this.throttle.hit(name, HOUR);
    if (hits.count > EMAILS_PER_HOUR)
      throw new AppError(429, 'EMAIL_RATE_LIMITED', { retryAfter: hits.retryAfter });
  }

  private link(context: AccessContext, locale: MailLocale, page: string, token?: string) {
    const path = `${context.origin}/${locale}/${page}`;
    return token ? `${path}?token=${token}` : path;
  }

  /**
   * Sending is not waited for: the time a mail service takes would otherwise tell a stranger
   * whether the address has an account. A failure is logged, without the address or the link,
   * and the person can ask again.
   */
  private sendInBackground(message: MailMessage) {
    const attempt: Promise<void> = this.mailer
      .send(message)
      .catch(() => {
        this.logger.error({ code: 'MAIL_SEND_FAILED' }, 'An account email could not be sent');
      })
      .finally(() => this.sending.delete(attempt));
    this.sending.add(attempt);
  }
}
