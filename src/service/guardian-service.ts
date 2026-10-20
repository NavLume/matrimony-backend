import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import {
  GUARDIAN_INVITE_DAYS,
  type AdviceInput,
  type GuardianInvite,
  type GuardianPreview,
  type GuardianState,
  type WardSummary,
} from '../bo/guardian.js';
import type { Account } from '../bo/identity.js';
import { platformLegalVersions, type LegalVersionSource } from '../bo/legal.js';

import type { GuardedProfile, GuardianRow } from '../db/raw/repository/guardian-repository.js';
import type { GuardianDbService, GuardianUnit } from '../db/service/guardian-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  | 'guardian.requested'
  | 'guardian.consented'
  | 'guardian.invited'
  | 'guardian.accepted'
  | 'guardian.removed'
  | 'guardian.advised'
>;

/** What the process needs to send the invitation email. */
export interface InvitationToSend {
  email: string;
  displayName: string;
  clientName: string;
  locale: 'bn' | 'en';
}

/**
 * The rules for a client's guardian (see bo/guardian.ts).
 *
 * - Only an admin, or the agent who looks after the client, asks for a guardian. Anyone else gets
 *   "not found", as everywhere else.
 * - The client agrees first. A client who signs in agrees in the app and the invitation is sent then;
 *   for a client with no login the agent confirms the client agreed, and who did so is kept.
 * - One guardian per profile. An address that already has an account is never invited.
 * - A guardian is linked to one profile and only advises on proposals the client received.
 * - The client or the agency can remove the guardian at any time; a removed guardian sees nothing.
 */
export class GuardianService {
  constructor(
    private readonly db: Pick<GuardianDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly legalVersions: LegalVersionSource = platformLegalVersions,
  ) {}

  // ---- the agency ----------------------------------------------------------------------------

  async stateForStaff(actor: ProfileActor, profileId: string): Promise<GuardianState> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.managed(unit, actor, profileId);
      return this.read(unit, actor.agencyId, profile);
    });
  }

  /** Asks for a guardian. `tokenHash` is stored only when the invitation can go out at once. */
  async invite(
    actor: ProfileActor,
    profileId: string,
    input: GuardianInvite,
    tokenHash: string,
    correlationId: string,
  ): Promise<{ state: GuardianState; send: InvitationToSend | null }> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.managed(unit, actor, profileId, true);
      if (await unit.current(actor.agencyId, profile.id, true))
        throw new AppError(409, 'GUARDIAN_EXISTS');
      if (await unit.accountExists(actor.agencyId, input.email))
        throw new AppError(409, 'EMAIL_IN_USE');
      const clientSignsIn = profile.ownerAccountId !== null;
      if (!clientSignsIn && input.clientAgreed !== true)
        throw new AppError(400, 'INVALID_REQUEST', {
          fields: [{ path: 'clientAgreed', code: 'required' }],
        });
      const id = await unit.insert(actor.agencyId, {
        profileId: profile.id,
        email: input.email,
        displayName: input.displayName,
        locale: input.locale,
        status: clientSignsIn ? 'awaiting_client' : 'invited',
        consentBasis: clientSignsIn ? null : 'agent_recorded',
        consentedBy: clientSignsIn ? null : actor.accountId,
        tokenHash: clientSignsIn ? null : tokenHash,
        days: GUARDIAN_INVITE_DAYS,
        invitedBy: actor.accountId,
      });
      if (clientSignsIn) {
        await unit.notifyClientApproval(actor.agencyId, profile.id, id);
        await unit.appendEvent(this.event('guardian.requested', actor, id, correlationId));
      } else {
        await unit.appendEvent(this.event('guardian.invited', actor, id, correlationId));
      }
      return {
        state: await this.read(unit, actor.agencyId, profile),
        send: clientSignsIn
          ? null
          : {
              email: input.email,
              displayName: input.displayName,
              clientName: profile.fullName,
              locale: input.locale,
            },
      };
    });
  }

  /** A new link for an invitation that is out or has expired. */
  async resend(
    actor: ProfileActor,
    profileId: string,
    tokenHash: string,
    correlationId: string,
  ): Promise<{ state: GuardianState; send: InvitationToSend }> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.managed(unit, actor, profileId, true);
      const current = await unit.current(actor.agencyId, profile.id, true);
      if (!current || current.status !== 'invited') throw new AppError(404, 'GUARDIAN_NOT_FOUND');
      await unit.reissue(actor.agencyId, current.id, tokenHash, GUARDIAN_INVITE_DAYS);
      await unit.appendEvent(this.event('guardian.invited', actor, current.id, correlationId));
      return {
        state: await this.read(unit, actor.agencyId, profile),
        send: {
          email: current.email,
          displayName: current.displayName,
          clientName: profile.fullName,
          locale: current.locale,
        },
      };
    });
  }

  /** The agency ends the guardian (or cancels the request). */
  async removeByStaff(
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ): Promise<GuardianState> {
    this.staffOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.managed(unit, actor, profileId, true);
      await this.end(unit, actor, profile.id, correlationId);
      return this.read(unit, actor.agencyId, profile);
    });
  }

  // ---- the client ----------------------------------------------------------------------------

  async stateForClient(actor: ProfileActor): Promise<GuardianState> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.ownProfile(unit, actor);
      return this.read(unit, actor.agencyId, own);
    });
  }

  /** The client agrees to the guardian their agency asked for: the invitation is sent now. */
  async approve(
    actor: ProfileActor,
    tokenHash: string,
    correlationId: string,
  ): Promise<{ state: GuardianState; send: InvitationToSend }> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.ownProfile(unit, actor, true);
      const current = await unit.current(actor.agencyId, own.id, true);
      if (!current || current.status !== 'awaiting_client')
        throw new AppError(404, 'GUARDIAN_NOT_FOUND');
      await unit.consent(
        actor.agencyId,
        current.id,
        'client_in_app',
        actor.accountId,
        tokenHash,
        GUARDIAN_INVITE_DAYS,
      );
      await unit.notifyAnswer(actor.agencyId, own.id, current.id, 'approved');
      await unit.appendEvent(this.event('guardian.consented', actor, current.id, correlationId));
      return {
        state: await this.read(unit, actor.agencyId, own),
        send: {
          email: current.email,
          displayName: current.displayName,
          clientName: own.fullName,
          locale: current.locale,
        },
      };
    });
  }

  /** The client declines the request, or later removes their guardian. */
  async removeByClient(actor: ProfileActor, correlationId: string): Promise<GuardianState> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await this.ownProfile(unit, actor, true);
      const asked = await unit.current(actor.agencyId, own.id);
      await this.end(unit, actor, own.id, correlationId);
      // Declining a request is something the agent who asked wants to know.
      if (asked?.status === 'awaiting_client')
        await unit.notifyAnswer(actor.agencyId, own.id, asked.id, 'rejected');
      return this.read(unit, actor.agencyId, own);
    });
  }

  // ---- the invitation link -------------------------------------------------------------------

  async preview(agencyId: string, tokenHash: string): Promise<GuardianPreview | null> {
    const found = await this.db.inTransaction(agencyId, (unit) =>
      unit.byLink(agencyId, tokenHash, false),
    );
    return (
      found && {
        displayName: found.displayName,
        clientName: found.clientName,
        locale: found.locale,
      }
    );
  }

  /** Creates the guardian's account, links it to the profile and records what they agreed to. */
  async accept(
    agencyId: string,
    tokenHash: string,
    passwordHash: string,
    correlationId: string,
  ): Promise<Account | null> {
    const versions = await this.legalVersions(agencyId);
    return this.db.inTransaction(agencyId, async (unit): Promise<Account | null> => {
      const found = await unit.byLink(agencyId, tokenHash, true);
      if (!found) return null;
      const account = await unit.createAccount(agencyId, {
        id: this.newId(),
        displayName: found.displayName,
        email: found.email,
        locale: found.locale,
      });
      // Another account has the address: nothing is created and the link stays out.
      if (!account) throw new AppError(409, 'ADDRESS_IN_USE');
      await unit.createCredential(agencyId, account.id, passwordHash);
      await unit.recordConsents(agencyId, account.id, [
        { purpose: 'terms', documentVersion: versions.terms },
        { purpose: 'privacy', documentVersion: versions.privacy },
      ]);
      if (!(await unit.markAccepted(agencyId, found.id, account.id)))
        throw new AppError(409, 'ADDRESS_IN_USE');
      await unit.appendEvent({
        id: this.newId(),
        agencyId,
        actorId: account.id,
        subjectId: found.id,
        type: 'guardian.accepted',
        version: 1,
        occurredAt: this.now().toISOString(),
        correlationId,
      });
      return account;
    });
  }

  // ---- the guardian --------------------------------------------------------------------------

  /** The client the guardian looks after. */
  async ward(actor: ProfileActor): Promise<WardSummary> {
    this.guardianOnly(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await unit.guardedBy(actor.agencyId, actor.accountId);
      if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return { profileId: profile.id, memberCode: profile.memberCode, fullName: profile.fullName };
    });
  }

  /** Advice on a proposal the client received and has not answered yet. Advising again replaces it. */
  async advise(
    actor: ProfileActor,
    interestId: string,
    input: AdviceInput,
    correlationId: string,
  ): Promise<void> {
    this.guardianOnly(actor);
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await unit.guardedBy(actor.agencyId, actor.accountId);
      if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
      const status = await unit.receivedProposal(actor.agencyId, interestId, profile.id);
      if (status === null) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      if (status !== 'pending') throw new AppError(409, 'PROPOSAL_NOT_OPEN');
      await unit.saveAdvice(
        actor.agencyId,
        interestId,
        profile.id,
        input.advice,
        input.note ?? null,
        actor.accountId,
      );
      await unit.notifyAdvice(actor.agencyId, interestId, profile.id, actor.accountId);
      await unit.appendEvent(this.event('guardian.advised', actor, interestId, correlationId));
    });
  }

  // ---- helpers -------------------------------------------------------------------------------

  private async end(
    unit: GuardianUnit,
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ) {
    const current = await unit.current(actor.agencyId, profileId, true);
    if (!current) throw new AppError(404, 'GUARDIAN_NOT_FOUND');
    await unit.remove(actor.agencyId, current.id, actor.accountId);
    await unit.appendEvent(this.event('guardian.removed', actor, current.id, correlationId));
  }

  private async read(
    unit: GuardianUnit,
    agencyId: string,
    profile: GuardedProfile,
  ): Promise<GuardianState> {
    const clientHasLogin = profile.ownerAccountId !== null;
    const g: GuardianRow | null = await unit.current(agencyId, profile.id);
    if (!g)
      return {
        state: 'none',
        displayName: null,
        email: null,
        expiresAt: null,
        consentBasis: null,
        consentedAt: null,
        clientHasLogin,
      };
    return {
      state: g.status === 'invited' && g.expired ? 'expired' : (g.status as GuardianState['state']),
      displayName: g.displayName,
      email: g.email,
      expiresAt: g.expiresAt,
      consentBasis: g.consentBasis,
      consentedAt: g.consentedAt,
      clientHasLogin,
    };
  }

  private async managed(
    unit: GuardianUnit,
    actor: ProfileActor,
    profileId: string,
    lock = false,
  ): Promise<GuardedProfile> {
    const profile = await unit.profile(actor.agencyId, profileId, lock);
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  private async ownProfile(unit: GuardianUnit, actor: ProfileActor, lock = false) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    const own = await unit.ownProfile(actor.agencyId, actor.accountId);
    if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
    if (lock) await unit.profile(actor.agencyId, own.id, true);
    return own;
  }

  private staffOnly(actor: ProfileActor) {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private guardianOnly(actor: ProfileActor) {
    if (actor.role !== 'guardian') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: this.newId(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      subjectId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    };
  }
}
