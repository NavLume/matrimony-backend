import { randomUUID } from 'node:crypto';
import { canManage, type Role } from '../bo/access.js';
import {
  CLIENT_LOGIN_DAYS,
  type ClientLoginGrant,
  type ClientLoginPreview,
  type ClientLoginStatus,
} from '../bo/client-login.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { Account } from '../bo/identity.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../bo/registration.js';
import type {
  ClientLoginDbService,
  ClientLoginUnit,
} from '../db/service/client-login-db-service.js';
import type { LoginProfile } from '../db/raw/repository/client-login-repository.js';
import { AppError } from '../exception/app-error.js';

/** The staff member giving the client a login. */
export interface LoginActor {
  agencyId: string;
  accountId: string;
  role: Role;
}

/**
 * Giving a client the agency runs a login of their own.
 *
 * - Only an admin, or the agent who looks after the client, sends the link.
 * - Only a client with no account can be given one: an account is never attached to a profile that
 *   already has an owner, and never replaces one.
 * - The client chooses their own password when they open the link. Only a hash of the link's secret
 *   is stored, and opening it is one transaction, so it works once even when opened twice at once.
 * - The profile stays 'assisted': the agent keeps the control they had. The client becomes its owner,
 *   so it is theirs to see and to edit (every edit is reviewed, as for any member).
 */
export class ClientLoginService {
  constructor(private readonly db: ClientLoginDbService) {}

  async status(actor: LoginActor, profileId: string): Promise<ClientLoginStatus> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.managed(unit, actor, profileId);
      return this.statusOf(unit, actor.agencyId, profile);
    });
  }

  /** Puts a new link in place of any link still out, and returns the status that goes with it. */
  async grant(
    actor: LoginActor,
    profileId: string,
    input: ClientLoginGrant,
    tokenHash: string,
    correlationId: string,
  ): Promise<{ status: ClientLoginStatus; fullName: string }> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.managed(unit, actor, profileId, true);
      if (profile.ownerAccountId) throw new AppError(409, 'CLIENT_HAS_LOGIN');
      if (profile.serviceMode !== 'assisted') throw new AppError(409, 'CLIENT_NOT_ASSISTED');
      await unit.replaceLink(actor.agencyId, {
        profileId,
        channel: input.channel,
        email: input.channel === 'email' ? input.email : null,
        phone: input.channel === 'sms' ? input.phone : null,
        locale: input.locale,
        tokenHash,
        days: CLIENT_LOGIN_DAYS,
        createdBy: actor.accountId,
      });
      await unit.appendEvent(
        this.event(
          'client.login_invited',
          actor.agencyId,
          actor.accountId,
          profileId,
          correlationId,
        ),
      );
      return {
        status: await this.statusOf(unit, actor.agencyId, profile),
        fullName: profile.fullName,
      };
    });
  }

  /** Cancels the link that is out. A login that exists is not touched here. */
  async revoke(actor: LoginActor, profileId: string, correlationId: string): Promise<void> {
    this.requireStaff(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.managed(unit, actor, profileId, true);
      if (!(await unit.revokeOpen(actor.agencyId, profileId)))
        throw new AppError(404, 'CLIENT_LOGIN_NOT_FOUND');
      await unit.appendEvent(
        this.event(
          'client.login_revoked',
          actor.agencyId,
          actor.accountId,
          profileId,
          correlationId,
        ),
      );
    });
  }

  /** What the link is for, without using it up. Null when it is unknown, used, cancelled or old. */
  async preview(agencyId: string, tokenHash: string): Promise<ClientLoginPreview | null> {
    const found = await this.db.inTransaction(agencyId, (unit) =>
      unit.byLink(agencyId, tokenHash, false),
    );
    if (!found || found.ownerAccountId) return null;
    return { displayName: found.fullName, channel: found.channel, locale: found.locale };
  }

  /** Creates the account, attaches it to the profile and records what the client agreed to. */
  async accept(
    agencyId: string,
    tokenHash: string,
    passwordHash: string,
    correlationId: string,
  ): Promise<Account | null> {
    return this.db.inTransaction(agencyId, async (unit): Promise<Account | null> => {
      const found = await unit.byLink(agencyId, tokenHash, true);
      if (!found || found.ownerAccountId) return null;
      const account = await unit.createAccount(agencyId, {
        id: randomUUID(),
        displayName: found.fullName,
        channel: found.channel,
        email: found.email,
        phone: found.phone,
        locale: found.locale,
      });
      // Another account has the address: nothing is created, and the link stays out.
      if (!account) throw new AppError(409, 'ADDRESS_IN_USE');
      await unit.createCredential(agencyId, account.id, passwordHash);
      await unit.recordConsents(agencyId, account.id, [
        { purpose: 'terms', documentVersion: TERMS_VERSION },
        { purpose: 'privacy', documentVersion: PRIVACY_VERSION },
      ]);
      // The profile only ever gets an owner while it has none. If it just got one, none of this stands.
      if (!(await unit.attachOwner(agencyId, found.profileId, account.id)))
        throw new AppError(409, 'CLIENT_HAS_LOGIN');
      await unit.markAccepted(agencyId, found.id, account.id);
      await unit.appendEvent(
        this.event('client.login_accepted', agencyId, account.id, found.profileId, correlationId),
      );
      return account;
    });
  }

  private async managed(
    unit: ClientLoginUnit,
    actor: LoginActor,
    profileId: string,
    lock = false,
  ): Promise<LoginProfile> {
    const profile = await unit.profile(actor.agencyId, profileId, lock);
    // A client an agent does not look after is not found for them, as everywhere else.
    if (!profile || !canManage(actor, profile)) throw new AppError(404, 'CLIENT_NOT_FOUND');
    return profile;
  }

  private async statusOf(
    unit: ClientLoginUnit,
    agencyId: string,
    profile: LoginProfile,
  ): Promise<ClientLoginStatus> {
    const empty = {
      channel: null,
      address: null,
      locale: null,
      expiresAt: null,
      invitedByName: null,
      accountName: null,
    } as const;
    if (profile.ownerAccountId) {
      return { ...empty, state: 'active', canGrant: false, accountName: profile.ownerName };
    }
    const canGrant = profile.serviceMode === 'assisted';
    const open = await unit.open(agencyId, profile.id);
    if (!open) return { ...empty, state: 'none', canGrant };
    return {
      state: open.expired ? 'expired' : 'invited',
      canGrant,
      channel: open.channel,
      address: open.channel === 'email' ? open.email : open.phone,
      locale: open.locale,
      expiresAt: open.expiresAt,
      invitedByName: open.invitedByName,
      accountName: null,
    };
  }

  private requireStaff(actor: LoginActor) {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private event(
    type: WorkflowEvent['type'],
    agencyId: string,
    actorId: string,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
      agencyId,
      actorId,
      subjectId,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
    };
  }
}
