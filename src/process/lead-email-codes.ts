import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import { PHONE_CODE_LENGTH } from '../bo/phone.js';
import type { PhoneCodeRepository } from '../cache/repository/phone-code-repository.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import { AppError } from '../exception/app-error.js';
import { emailCodeEmail } from '../mail/messages.js';
import type { Mailer } from '../mail/mailer.js';
import type { SecretBox } from '../security/secret-box.js';
import { digest } from '../security/secret-box.js';

/** How long a code works. The email says 10 minutes, so change both together. */
const CODE_SECONDS = 600;
const RESEND_SECONDS = 60;
const CODES_PER_ADDRESS_PER_HOUR = 5;
const CODES_PER_AGENCY_PER_DAY = 2000;
const MAX_WRONG_GUESSES = 5;

/**
 * Talk to an adviser for a visitor abroad: a 6-digit code to their email instead of a text message (no SMS is sent
 * outside Bangladesh). It proves the address, so the enquiry can later be joined to the client by it. The limits match
 * the phone codes: one a minute and five an hour per address, a daily cap per agency, five wrong guesses.
 */
export class LeadEmailCodes {
  constructor(
    private readonly codes: Pick<PhoneCodeRepository, 'put' | 'check'>,
    private readonly throttle: Pick<ThrottleRepository, 'hit'>,
    private readonly box: SecretBox,
    private readonly mailer: Mailer,
    private readonly logger: Logger,
  ) {}

  async send(
    context: { agencyId: string; agencyName: string },
    email: string,
    locale: 'bn' | 'en',
  ): Promise<{ resendAfter: number; expiresIn: number }> {
    const address = digest(email);
    await this.limit(`lead-email-gap:${context.agencyId}:${address}`, 1, RESEND_SECONDS);
    await this.limit(
      `lead-email-hour:${context.agencyId}:${address}`,
      CODES_PER_ADDRESS_PER_HOUR,
      3600,
    );
    await this.limit(`lead-email-day:${context.agencyId}`, CODES_PER_AGENCY_PER_DAY, 86400);

    const scope = this.scope(context.agencyId, email);
    const code = String(randomInt(0, 10 ** PHONE_CODE_LENGTH)).padStart(PHONE_CODE_LENGTH, '0');
    await this.codes.put(scope, this.box.mac(`${scope}.${code}`), CODE_SECONDS);
    try {
      await this.mailer.send(
        emailCodeEmail({
          to: email,
          locale,
          agencyName: context.agencyName,
          code,
          purpose: 'consultation',
        }),
      );
    } catch {
      // Never the address or the code in the log.
      this.logger.error({ code: 'LEAD_EMAIL_FAILED' }, 'A consultation code email was not sent');
      throw new AppError(502, 'EMAIL_UNAVAILABLE');
    }
    return { resendAfter: RESEND_SECONDS, expiresIn: CODE_SECONDS };
  }

  /** Throws CODE_INVALID (try again) or CODE_EXPIRED (ask for a new one). */
  async check(agencyId: string, email: string, code: string) {
    const scope = this.scope(agencyId, email);
    const result = await this.codes.check(
      scope,
      this.box.mac(`${scope}.${code}`),
      MAX_WRONG_GUESSES,
    );
    if (result === 'ok') return;
    throw new AppError(400, result === 'wrong' ? 'CODE_INVALID' : 'CODE_EXPIRED');
  }

  private scope(agencyId: string, email: string) {
    return `lead-email:${agencyId}:${digest(email)}`;
  }

  private async limit(name: string, max: number, windowSeconds: number) {
    const hits = await this.throttle.hit(name, windowSeconds);
    if (hits.count > max)
      throw new AppError(429, 'CODE_RATE_LIMITED', { retryAfter: hits.retryAfter });
  }
}
