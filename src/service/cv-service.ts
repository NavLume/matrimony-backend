import { randomUUID } from 'node:crypto';
import { canManage, isStaff } from '../bo/access.js';
import type { CvInfo, CvRecord, CvState } from '../bo/cv.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { CvProfile } from '../db/raw/repository/cv-repository.js';
import type { CvDbService, CvUnit } from '../db/service/cv-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  'cv.uploaded' | 'cv.removed' | 'cv.approved' | 'cv.rejected'
>;

/** Whose CV: the signed-in member's own, or a client's, for staff who look after them. */
export type CvTarget = { kind: 'own' } | { kind: 'client'; profileId: string };

/** A place held for an upload, and where its file will go. */
export interface CvReservation {
  profileId: string;
  cvId: string;
  storageKey: string;
  /** A member's own upload waits for a reviewer; staff uploading for an assisted client publish at once. */
  status: 'pending' | 'published';
}

/** The new state of a profile's CVs, and the files that no longer belong to anything. */
export interface CvChange {
  state: CvState;
  deleteKeys: string[];
}

const info = (cv: CvRecord): CvInfo => ({
  id: cv.id,
  fileName: cv.fileName,
  byteSize: cv.byteSize,
  uploadedAt: cv.uploadedAt,
  uploadedByStaff: cv.uploadedByStaff,
});

/** The picture the owner and staff see: the CV others can see, and the replacement waiting or turned down. */
export function stateOf(live: readonly CvRecord[]): CvState {
  const current = live.find((cv) => cv.status === 'published') ?? null;
  const next = live.find((cv) => cv.status === 'pending' || cv.status === 'rejected') ?? null;
  return {
    current: current && info(current),
    replacement: next && {
      ...info(next),
      state: next.status === 'pending' ? 'waiting' : 'rejected',
      reviewerNotes: next.reviewerNotes,
    },
  };
}

/**
 * The rules for a profile's CV.
 *
 * - A member has one CV on their own profile. Staff who look after an assisted client may keep one
 *   for them. Staff do not change the content of a member who runs their own profile, so they cannot
 *   upload for one, but they review what the member uploaded.
 * - A member's upload waits for review; staff uploading for an assisted client publish at once.
 * - Replacing keeps the old CV published until the new one is approved. There is never more than one
 *   CV others can see, and one replacement waiting or turned down.
 * - Another person sees a CV only through an accepted connection.
 *
 * Files are not handled here. See `CvProcess`, which stores them and calls this.
 */
export class CvService {
  constructor(
    private readonly db: Pick<CvDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async state(actor: ProfileActor, target: CvTarget): Promise<CvState> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target, false);
      return stateOf(await unit.live(actor.agencyId, profile.id));
    });
  }

  /** Checks the upload is allowed and holds a place for it. Fails early, before a file is processed. */
  async reserve(actor: ProfileActor, target: CvTarget): Promise<CvReservation> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target, false);
      this.requireContentChange(target, profile);
      const cvId = this.newId();
      return {
        profileId: profile.id,
        cvId,
        // Begins with the agency and the profile, as the database requires.
        storageKey: `${actor.agencyId}/${profile.id}/cv-${cvId}.pdf`,
        status: target.kind === 'own' ? 'pending' : 'published',
      };
    });
  }

  /** Records the CV once its file is stored, replacing what it replaces. */
  async attach(
    actor: ProfileActor,
    target: CvTarget,
    reservation: CvReservation,
    fileName: string,
    byteSize: number,
    correlationId: string,
  ): Promise<CvChange> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target, true);
      if (profile.id !== reservation.profileId) throw new AppError(409, 'PROFILE_STATE_INVALID');
      this.requireContentChange(target, profile);

      const deleteKeys: string[] = [];
      for (const old of await unit.live(actor.agencyId, profile.id)) {
        // A published CV is replaced at once only when the new one is published at once.
        if (old.status === 'published' && reservation.status === 'pending') continue;
        await unit.markRemoved(actor.agencyId, old.id);
        deleteKeys.push(old.storageKey);
      }
      await unit.insert(actor.agencyId, {
        id: reservation.cvId,
        profileId: profile.id,
        storageKey: reservation.storageKey,
        fileName,
        byteSize,
        status: reservation.status,
        uploadedBy: actor.accountId,
      });
      await unit.appendEvent(this.event('cv.uploaded', actor, reservation.cvId, correlationId));
      return { state: stateOf(await unit.live(actor.agencyId, profile.id)), deleteKeys };
    });
  }

  /** Takes the CV away: the one others see and any replacement. */
  async remove(actor: ProfileActor, target: CvTarget, correlationId: string): Promise<CvChange> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target, true);
      // A member may always take back their own CV. Staff only for a client they run.
      if (target.kind === 'client') this.requireContentChange(target, profile);
      const deleteKeys: string[] = [];
      for (const cv of await unit.live(actor.agencyId, profile.id)) {
        await unit.markRemoved(actor.agencyId, cv.id);
        deleteKeys.push(cv.storageKey);
        await unit.appendEvent(this.event('cv.removed', actor, cv.id, correlationId));
      }
      return { state: stateOf([]), deleteKeys };
    });
  }

  /** Staff approve or turn down the waiting replacement. Approving publishes it and retires the old one. */
  async review(
    actor: ProfileActor,
    profileId: string,
    approve: boolean,
    notes: string | null,
    correlationId: string,
  ): Promise<CvChange> {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId }, true);
      const waiting = (await unit.live(actor.agencyId, profile.id)).find(
        (cv) => cv.status === 'pending',
      );
      if (!waiting) throw new AppError(409, 'CV_NOT_WAITING');
      const deleteKeys: string[] = [];
      // The CV that was published is retired first: there is only ever one that others can see.
      if (approve) {
        for (const old of await unit.live(actor.agencyId, profile.id)) {
          if (old.status === 'published') {
            await unit.markRemoved(actor.agencyId, old.id);
            deleteKeys.push(old.storageKey);
          }
        }
      }
      if (!(await unit.decide(actor.agencyId, waiting.id, approve, actor.accountId, notes))) {
        throw new AppError(409, 'CV_NOT_WAITING');
      }
      await unit.appendEvent(
        this.event(approve ? 'cv.approved' : 'cv.rejected', actor, waiting.id, correlationId),
      );
      return { state: stateOf(await unit.live(actor.agencyId, profile.id)), deleteKeys };
    });
  }

  /** The file of the CV the owner or staff asked for: the one others see, or the waiting replacement. */
  async locate(
    actor: ProfileActor,
    target: CvTarget,
    which: 'current' | 'replacement',
  ): Promise<{ storageKey: string; fileName: string }> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target, false);
      const live = await unit.live(actor.agencyId, profile.id);
      const cv =
        which === 'current'
          ? live.find((c) => c.status === 'published')
          : live.find((c) => c.status === 'pending' || c.status === 'rejected');
      if (!cv) throw new AppError(404, 'CV_NOT_FOUND');
      return { storageKey: cv.storageKey, fileName: cv.fileName };
    });
  }

  /**
   * The published CV of another person, for a member who is connected to them. Anyone else, or a
   * pair that is not an accepted connection, gets the same answer as when there is no CV.
   */
  async locateForConnection(
    actor: ProfileActor,
    candidateId: string,
  ): Promise<{ storageKey: string; fileName: string }> {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId, false);
      if (!own || own.status !== 'active') throw new AppError(404, 'CV_NOT_FOUND');
      const other = await unit.profileById(actor.agencyId, candidateId, false);
      if (!other || other.status !== 'active') throw new AppError(404, 'CV_NOT_FOUND');
      if (!(await unit.accepted(actor.agencyId, own.id, other.id))) {
        throw new AppError(404, 'CV_NOT_FOUND');
      }
      const cv = await unit.published(actor.agencyId, other.id);
      if (!cv) throw new AppError(404, 'CV_NOT_FOUND');
      return { storageKey: cv.storageKey, fileName: cv.fileName };
    });
  }

  /** Whether a connected person has a CV to show, and how big it is. Same answer as no CV otherwise. */
  async infoForConnection(actor: ProfileActor, candidateId: string): Promise<CvInfo | null> {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId, false);
      if (!own || own.status !== 'active') return null;
      const other = await unit.profileById(actor.agencyId, candidateId, false);
      if (!other || other.status !== 'active') return null;
      if (!(await unit.accepted(actor.agencyId, own.id, other.id))) return null;
      const cv = await unit.published(actor.agencyId, other.id);
      return cv ? info(cv) : null;
    });
  }

  // ------------------------------------------------------------------------------------------

  /** The profile the target names, for someone who may work with it. Anything else is not found. */
  private async profileOf(
    unit: CvUnit,
    actor: ProfileActor,
    target: CvTarget,
    lock: boolean,
  ): Promise<CvProfile> {
    if (target.kind === 'own') {
      if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
      const own = await unit.ownProfile(actor.agencyId, actor.accountId, lock);
      if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return own;
    }
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
    const profile = await unit.profileById(actor.agencyId, target.profileId, lock);
    if (!profile || !canManage(actor, profile)) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  /** Changing the CV is a change to the profile: never on a closed one, and staff only for an assisted client. */
  private requireContentChange(target: CvTarget, profile: CvProfile) {
    if (profile.status === 'closed') throw new AppError(409, 'PROFILE_STATE_INVALID');
    if (target.kind === 'client' && profile.serviceMode !== 'assisted') {
      throw new AppError(403, 'PROFILE_SELF_SERVICE');
    }
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    cvId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
      subjectId: cvId,
    };
  }
}
