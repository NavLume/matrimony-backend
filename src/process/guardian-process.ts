import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { AdviceInput, GuardianAccept, GuardianInvite } from '../bo/guardian.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import { AppError } from '../exception/app-error.js';
import type { Mailer } from '../mail/mailer.js';
import { guardianInviteEmail } from '../mail/messages.js';
import { digest } from '../security/secret-box.js';
import type { CredentialService } from '../service/credential-service.js';
import type { GuardianService, InvitationToSend } from '../service/guardian-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { AuthProcess } from './auth-process.js';

/** Invitations one staff member can send per hour, and links one address can be sent per hour. */
const PER_STAFF_PER_HOUR = 20;
const PER_ADDRESS_PER_HOUR = 3;
const HOUR = 3600;

/** The agency the request is for, which the message names and links back to. */
export interface GuardianContext {
  agencyId: string;
  agencyName: string;
  /** The address the person's browser used, for example https://marriage.example. */
  origin: string;
}

const newToken = () => randomBytes(32).toString('base64url');
/** The agency is part of what is hashed, so a link only works on the agency that sent it. */
const linkHash = (agencyId: string, token: string) => digest(`${agencyId}.${token}`);

/**
 * A client's guardian: the invitation email and the link that opens the guardian's login. The link's
 * secret is random and only its hash is stored. A failure to send is logged without the address or
 * the link, and the agency can send it again.
 */
export class GuardianProcess {
  private readonly sending = new Set<Promise<void>>();

  constructor(
    private readonly guardians: Pick<
      GuardianService,
      | 'stateForStaff'
      | 'invite'
      | 'resend'
      | 'removeByStaff'
      | 'stateForClient'
      | 'approve'
      | 'removeByClient'
      | 'preview'
      | 'accept'
      | 'ward'
      | 'advise'
    >,
    private readonly credentials: Pick<CredentialService, 'hash'>,
    private readonly auth: Pick<AuthProcess, 'startSession'>,
    private readonly throttle: Pick<ThrottleRepository, 'hit'>,
    private readonly mailer: Mailer,
    private readonly logger: Logger,
  ) {}

  stateForStaff(actor: ProfileActor, profileId: string) {
    return this.guardians.stateForStaff(actor, profileId);
  }

  async invite(
    context: GuardianContext,
    actor: ProfileActor,
    profileId: string,
    input: GuardianInvite,
    correlationId: string,
  ) {
    await this.limit(`guardian:${context.agencyId}:${actor.accountId}`, PER_STAFF_PER_HOUR);
    const token = newToken();
    const result = await this.guardians.invite(
      actor,
      profileId,
      input,
      linkHash(context.agencyId, token),
      correlationId,
    );
    if (result.send) await this.send(context, result.send, token);
    return result.state;
  }

  async resend(
    context: GuardianContext,
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ) {
    await this.limit(`guardian:${context.agencyId}:${actor.accountId}`, PER_STAFF_PER_HOUR);
    const token = newToken();
    const result = await this.guardians.resend(
      actor,
      profileId,
      linkHash(context.agencyId, token),
      correlationId,
    );
    await this.send(context, result.send, token);
    return result.state;
  }

  removeByStaff(actor: ProfileActor, profileId: string, correlationId: string) {
    return this.guardians.removeByStaff(actor, profileId, correlationId);
  }

  stateForClient(actor: ProfileActor) {
    return this.guardians.stateForClient(actor);
  }

  /** The client agrees: the invitation goes out now. */
  async approve(context: GuardianContext, actor: ProfileActor, correlationId: string) {
    const token = newToken();
    const result = await this.guardians.approve(
      actor,
      linkHash(context.agencyId, token),
      correlationId,
    );
    await this.send(context, result.send, token);
    return result.state;
  }

  removeByClient(actor: ProfileActor, correlationId: string) {
    return this.guardians.removeByClient(actor, correlationId);
  }

  /** What the link is for, so the page can greet the person. Does not use the link up. */
  async preview(agencyId: string, token: string) {
    const found = await this.guardians.preview(agencyId, linkHash(agencyId, token));
    if (!found) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return found;
  }

  /** Creates the account, links it to the client and signs the person in. */
  async accept(agencyId: string, input: GuardianAccept, correlationId: string) {
    const hash = linkHash(agencyId, input.token);
    if (!(await this.guardians.preview(agencyId, hash)))
      throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const account = await this.guardians.accept(
      agencyId,
      hash,
      await this.credentials.hash(input.password),
      correlationId,
    );
    if (!account) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return this.auth.startSession(agencyId, account, correlationId);
  }

  ward(actor: ProfileActor) {
    return this.guardians.ward(actor);
  }

  advise(actor: ProfileActor, interestId: string, input: AdviceInput, correlationId: string) {
    return this.guardians.advise(actor, interestId, input, correlationId);
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

  /** Not waited for, so a slow mail service does not slow the page. A failure is logged. */
  private async send(context: GuardianContext, to: InvitationToSend, token: string) {
    await this.limit(
      `guardian-address:${context.agencyId}:${digest(to.email)}`,
      PER_ADDRESS_PER_HOUR,
    );
    const link = `${context.origin}/${to.locale}/accept-guardian?token=${token}`;
    const attempt: Promise<void> = this.mailer
      .send(
        guardianInviteEmail({
          to: to.email,
          locale: to.locale,
          agencyName: context.agencyName,
          name: to.displayName,
          clientName: to.clientName,
          link,
        }),
      )
      .catch(() => {
        this.logger.error(
          { code: 'GUARDIAN_INVITE_SEND_FAILED' },
          'A guardian invitation could not be sent',
        );
      })
      .finally(() => this.sending.delete(attempt));
    this.sending.add(attempt);
  }
}
