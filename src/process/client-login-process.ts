import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { ClientLoginAccept, ClientLoginGrant } from '../bo/client-login.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import { AppError } from '../exception/app-error.js';
import { clientLoginEmail } from '../mail/messages.js';
import type { Mailer } from '../mail/mailer.js';
import { digest } from '../security/secret-box.js';
import type { CredentialService } from '../service/credential-service.js';
import type { ClientLoginService, LoginActor } from '../service/client-login-service.js';
import { clientLoginMessage } from '../sms/messages.js';
import type { SmsSender } from '../sms/sender.js';
import type { AuthProcess } from './auth-process.js';

/** Links one staff member can send per hour, and links one address can be sent per hour. */
const LINKS_PER_STAFF_PER_HOUR = 30;
const LINKS_PER_ADDRESS_PER_HOUR = 3;
const HOUR = 3600;

/** The agency the request is for, which the message names and links back to. */
export interface ClientLoginContext {
  agencyId: string;
  agencyName: string;
  /** The address the staff member's browser used, for example https://marriage.example. */
  origin: string;
}

const newToken = () => randomBytes(32).toString('base64url');
/** The agency is part of what is hashed, so a link only works on the agency that sent it. */
const linkHash = (agencyId: string, token: string) => digest(`${agencyId}.${token}`);

/**
 * Giving a client a login: staff send a one-time link by text message or email, the client opens it,
 * chooses a password and is signed in.
 *
 * The link's secret is random and only its hash is stored. A failure to send is logged without the
 * address or the link, and the staff member can send it again.
 */
export class ClientLoginProcess {
  private readonly sending = new Set<Promise<void>>();

  constructor(
    private readonly logins: Pick<
      ClientLoginService,
      'status' | 'grant' | 'revoke' | 'preview' | 'accept'
    >,
    private readonly credentials: Pick<CredentialService, 'hash'>,
    private readonly auth: Pick<AuthProcess, 'startSession'>,
    private readonly throttle: Pick<ThrottleRepository, 'hit'>,
    private readonly mailer: Mailer,
    /** Undefined when no SMS sender is configured: only the email way is then offered. */
    private readonly sms: SmsSender | undefined,
    private readonly logger: Logger,
  ) {}

  status(actor: LoginActor, profileId: string) {
    return this.logins.status(actor, profileId);
  }

  async grant(
    context: ClientLoginContext,
    actor: LoginActor,
    profileId: string,
    input: ClientLoginGrant,
    correlationId: string,
  ) {
    if (input.channel === 'sms' && !this.sms) throw new AppError(409, 'SMS_NOT_AVAILABLE');
    await this.limit(
      `client-login:${context.agencyId}:${actor.accountId}`,
      LINKS_PER_STAFF_PER_HOUR,
    );
    const address = input.channel === 'sms' ? input.phone : input.email;
    await this.limit(
      `client-login-address:${context.agencyId}:${digest(address)}`,
      LINKS_PER_ADDRESS_PER_HOUR,
    );
    const token = newToken();
    const result = await this.logins.grant(
      actor,
      profileId,
      input,
      linkHash(context.agencyId, token),
      correlationId,
    );
    const link = `${context.origin}/${input.locale}/accept-login?token=${token}`;
    this.send(context, input, result.fullName, link);
    return result.status;
  }

  revoke(actor: LoginActor, profileId: string, correlationId: string) {
    return this.logins.revoke(actor, profileId, correlationId);
  }

  /** What the link is for, so the page can greet the person. Does not use the link up. */
  async preview(agencyId: string, token: string) {
    const found = await this.logins.preview(agencyId, linkHash(agencyId, token));
    if (!found) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return found;
  }

  /** Creates the account, attaches it to the client's profile, and signs the person in. */
  async accept(agencyId: string, input: ClientLoginAccept, correlationId: string) {
    const hash = linkHash(agencyId, input.token);
    const found = await this.logins.preview(agencyId, hash);
    if (!found) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const account = await this.logins.accept(
      agencyId,
      hash,
      await this.credentials.hash(input.password),
      correlationId,
    );
    if (!account) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return this.auth.startSession(agencyId, account, correlationId);
  }

  /** Resolves when every message handed over so far has been sent or has failed. For shutdown and tests. */
  async idle() {
    await Promise.allSettled([...this.sending]);
  }

  private async limit(name: string, max: number) {
    const hits = await this.throttle.hit(name, HOUR);
    if (hits.count > max)
      throw new AppError(429, 'EMAIL_RATE_LIMITED', { retryAfter: hits.retryAfter });
  }

  /** Not waited for, so a slow gateway does not slow the staff member's page. A failure is logged. */
  private send(context: ClientLoginContext, input: ClientLoginGrant, name: string, link: string) {
    const base = { locale: input.locale, agencyName: context.agencyName };
    const attempt: Promise<void> = (
      input.channel === 'email'
        ? this.mailer.send(clientLoginEmail({ ...base, to: input.email, name, link }))
        : this.sms!.send(clientLoginMessage({ ...base, to: input.phone, link }))
    )
      .catch(() => {
        this.logger.error(
          { code: 'CLIENT_LOGIN_SEND_FAILED' },
          'A client login link could not be sent',
        );
      })
      .finally(() => this.sending.delete(attempt));
    this.sending.add(attempt);
  }
}
