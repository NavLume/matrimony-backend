import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { canManage, mayDecideOwn } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import {
  DOCUMENT_EXTENSION,
  MAX_DOCUMENT_BYTES,
  type DocumentMime,
  type DocumentType,
  type VerificationState,
  type VerificationWaiting,
} from '../bo/verification.js';
import type {
  StoredRequest,
  VerificationProfile,
} from '../db/raw/repository/verification-repository.js';
import type {
  VerificationDbService,
  VerificationUnit,
} from '../db/service/verification-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { FileStorage } from '../storage/service/file-storage.js';
import { invoiceTypeOf } from './payment-service.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  | 'verification.submitted'
  | 'verification.approved'
  | 'verification.rejected'
  | 'verification.withdrawn'
  | 'verification.revoked'
  | 'verification.file_viewed'
>;

/** Whose verification: the signed-in member's own, or a client's, for staff who look after them. */
export type VerificationTarget = { kind: 'own' } | { kind: 'client'; profileId: string };

/**
 * The rules for identity verification (see bo/verification.ts).
 *
 * - The document is stored privately, opened only by staff who look after the client, and deleted
 *   as soon as the request is decided or withdrawn.
 * - Nobody decides their own submission, except an admin.
 * - Anyone else gets "not found" for a client they do not look after.
 */
export class VerificationService {
  constructor(
    private readonly db: Pick<VerificationDbService, 'inTransaction'>,
    private readonly storage: Pick<FileStorage, 'put' | 'get' | 'delete'>,
    private readonly logger: Pick<Logger, 'error'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async state(actor: ProfileActor, target: VerificationTarget): Promise<VerificationState> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target);
      return this.read(unit, actor, profile);
    });
  }

  async submit(
    actor: ProfileActor,
    target: VerificationTarget,
    docType: DocumentType,
    bytes: Buffer,
    declaredType: string,
    correlationId: string,
  ): Promise<VerificationState> {
    if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE');
    const mime = invoiceTypeOf(bytes, declaredType) as DocumentMime | null;
    if (!mime) throw new AppError(422, 'DOCUMENT_INVALID');
    const id = this.newId();
    // Checked first, so a file is not stored for a profile that cannot take it.
    const profile = await this.db.inTransaction(actor.agencyId, async (unit) => {
      const found = await this.profileOf(unit, actor, target);
      if (found.status === 'closed') throw new AppError(409, 'PROFILE_CLOSED');
      if (found.verifiedAt) throw new AppError(409, 'ALREADY_VERIFIED');
      if ((await unit.latest(actor.agencyId, found.id))?.row.status === 'pending')
        throw new AppError(409, 'VERIFICATION_PENDING');
      return found;
    });
    const key = `${actor.agencyId}/${profile.id}/verification-${id}.${DOCUMENT_EXTENSION[mime]}`;
    await this.storage.put(key, bytes, mime);
    try {
      return await this.db.inTransaction(actor.agencyId, async (unit) => {
        try {
          await unit.insert(actor.agencyId, {
            id,
            profileId: profile.id,
            docType,
            key,
            mime,
            size: bytes.length,
            submittedBy: actor.accountId,
          });
        } catch (error) {
          // The index that allows one waiting request: someone sent one at the same moment.
          if ((error as { code?: string }).code === '23505')
            throw new AppError(409, 'VERIFICATION_PENDING');
          throw error;
        }
        await unit.tellReviewers(actor.agencyId, profile.id, actor.accountId);
        await unit.appendEvent(this.event('verification.submitted', actor, id, correlationId));
        return this.read(unit, actor, profile);
      });
    } catch (error) {
      await this.removeFile(key);
      throw error;
    }
  }

  /** The person who sent it takes a waiting request back. */
  async withdraw(
    actor: ProfileActor,
    target: VerificationTarget,
    correlationId: string,
  ): Promise<VerificationState> {
    const result = await this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target);
      const request = await unit.latest(actor.agencyId, profile.id);
      if (!request || request.row.status !== 'pending')
        throw new AppError(404, 'VERIFICATION_NOT_FOUND');
      if (!(await unit.decide(actor.agencyId, request.row.id, 'withdrawn', actor.accountId, null)))
        throw new AppError(409, 'VERIFICATION_NOT_PENDING');
      await unit.appendEvent(
        this.event('verification.withdrawn', actor, request.row.id, correlationId),
      );
      return { request, state: await this.read(unit, actor, profile) };
    });
    await this.dispose(actor.agencyId, result.request);
    return result.state;
  }

  /** Staff approve a waiting request: the profile now carries the mark. */
  async approve(
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ): Promise<VerificationState> {
    return this.decide(actor, profileId, 'approved', null, correlationId);
  }

  /** Staff reject a waiting request, with a reason the person can act on. */
  async reject(
    actor: ProfileActor,
    profileId: string,
    note: string,
    correlationId: string,
  ): Promise<VerificationState> {
    return this.decide(actor, profileId, 'rejected', note, correlationId);
  }

  /** An admin takes the mark away. */
  async revoke(
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ): Promise<VerificationState> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      if (!profile.verifiedAt) throw new AppError(409, 'NOT_VERIFIED');
      await unit.setVerified(actor.agencyId, profile.id, null);
      await unit.appendEvent(this.event('verification.revoked', actor, profile.id, correlationId));
      return this.read(unit, actor, { ...profile, verifiedAt: null });
    });
  }

  /** The waiting document, for staff who look after the client. Opening it is recorded. */
  async file(
    actor: ProfileActor,
    profileId: string,
    correlationId: string,
  ): Promise<{ bytes: Buffer; mime: DocumentMime }> {
    const found = await this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      const request = await unit.latest(actor.agencyId, profile.id);
      if (!request || request.row.status !== 'pending' || request.fileRemoved)
        throw new AppError(404, 'VERIFICATION_NOT_FOUND');
      const mime = await unit.mimeOf(actor.agencyId, request.row.id);
      await unit.appendEvent(
        this.event('verification.file_viewed', actor, request.row.id, correlationId),
      );
      return { request, mime };
    });
    const bytes = await this.storage.get(found.request.fileKey);
    if (!bytes || !found.mime) throw new AppError(404, 'VERIFICATION_NOT_FOUND');
    return { bytes, mime: found.mime };
  }

  /** Requests waiting for a decision, for the staff who may decide them. */
  async waiting(actor: ProfileActor): Promise<VerificationWaiting[]> {
    if (actor.role === 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, (unit) =>
      unit.waiting(actor.agencyId, actor.role === 'admin' ? null : actor.accountId),
    );
  }

  private async decide(
    actor: ProfileActor,
    profileId: string,
    outcome: 'approved' | 'rejected',
    note: string | null,
    correlationId: string,
  ): Promise<VerificationState> {
    const result = await this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      const request = await unit.latest(actor.agencyId, profile.id);
      if (!request || request.row.status !== 'pending')
        throw new AppError(404, 'VERIFICATION_NOT_FOUND');
      if (request.submittedBy === actor.accountId && !mayDecideOwn(actor))
        throw new AppError(409, 'REVIEW_OWN_SUBMISSION');
      if (!(await unit.decide(actor.agencyId, request.row.id, outcome, actor.accountId, note)))
        throw new AppError(409, 'VERIFICATION_NOT_PENDING');
      if (outcome === 'approved')
        await unit.setVerified(actor.agencyId, profile.id, actor.accountId);
      await unit.tellDecided(
        actor.agencyId,
        profile.id,
        request.submittedBy,
        actor.accountId,
        outcome,
      );
      await unit.appendEvent(
        this.event(
          outcome === 'approved' ? 'verification.approved' : 'verification.rejected',
          actor,
          request.row.id,
          correlationId,
        ),
      );
      return {
        request,
        state: await this.read(unit, actor, {
          ...profile,
          verifiedAt: outcome === 'approved' ? this.now().toISOString() : profile.verifiedAt,
        }),
      };
    });
    await this.dispose(actor.agencyId, result.request);
    return result.state;
  }

  /** Deletes the document once its request is closed, and records that it is gone. */
  private async dispose(agencyId: string, request: StoredRequest): Promise<void> {
    if (!(await this.removeFile(request.fileKey))) return;
    await this.db
      .inTransaction(agencyId, (unit) => unit.markFileRemoved(agencyId, request.row.id))
      .catch(() => {
        this.logger.error({ code: 'VERIFICATION_MARK_FAILED' }, 'Could not note a removed file');
      });
  }

  private async removeFile(key: string): Promise<boolean> {
    try {
      await this.storage.delete(key);
      return true;
    } catch {
      // Only the code is logged: a storage error can carry the bucket or the path.
      this.logger.error(
        { code: 'VERIFICATION_FILE_DELETE_FAILED' },
        'Could not delete a verification document',
      );
      return false;
    }
  }

  private async read(
    unit: VerificationUnit,
    actor: ProfileActor,
    profile: VerificationProfile,
  ): Promise<VerificationState> {
    const latest = await unit.latest(actor.agencyId, profile.id);
    return {
      verified: profile.verifiedAt ? { at: profile.verifiedAt } : null,
      request: latest?.row ?? null,
    };
  }

  /** The profile the actor may work on, or "not found". */
  private async profileOf(
    unit: VerificationUnit,
    actor: ProfileActor,
    target: VerificationTarget,
  ): Promise<VerificationProfile> {
    if (target.kind === 'own') {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return own;
    }
    if (actor.role === 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    const profile = await unit.profileById(actor.agencyId, target.profileId);
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
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
