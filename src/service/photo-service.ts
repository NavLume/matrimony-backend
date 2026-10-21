import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import {
  MAX_PHOTOS,
  type PhotoList,
  type PhotoPrivacy,
  type PhotoReservation,
} from '../bo/photo.js';
import type { PhotoDbService, PhotoUnit } from '../db/service/photo-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  'photo.uploaded' | 'photo.removed' | 'photo.privacy_changed'
>;

/**
 * Whose photos: the signed-in member's own, or a client's, for the staff who look after the client (an admin:
 * any; an agent: those assigned to them), whether the client has a login or not.
 */
export type PhotoTarget = { kind: 'own' } | { kind: 'client'; profileId: string };
const OWN: PhotoTarget = { kind: 'own' };

/**
 * The rules for a client's photos.
 *
 * - A member manages their own photos, on a profile they have already saved. Staff manage the photos of the
 *   clients they look after, with or without a login: a photo an agent adds waits for review like any other,
 *   and an agent's own upload is reviewed by an admin (nobody reviews their own submission).
 * - At most `MAX_PHOTOS` at a time. The check is repeated inside the transaction that holds the
 *   profile's row lock, so two uploads at once cannot both pass the same check.
 * - A new photo waits for a reviewer. Only an approved photo can be made the main photo.
 * - Removing a photo is immediate: a member may always take back their own picture.
 *
 * Files are not handled here. See `PhotoProcess`, which stores them and calls this.
 */
export class PhotoService {
  constructor(
    private readonly db: Pick<PhotoDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async list(actor: ProfileActor, target: PhotoTarget = OWN): Promise<PhotoList> {
    this.requireRole(actor, target);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.find(unit, actor, target, false);
      return profile
        ? this.listOf(unit, actor, profile.id)
        : { photos: [], limit: MAX_PHOTOS, privacy: 'clear' as const };
    });
  }

  /**
   * Holds a place for an upload and says where its files will go. Fails early, so a member who is
   * over the limit does not wait for a large picture to be processed first.
   */
  async reserve(actor: ProfileActor, target: PhotoTarget = OWN): Promise<PhotoReservation> {
    this.requireRole(actor, target);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, target, false);
      await this.requireRoom(unit, actor, profile.id);
      const photoId = this.newId();
      return {
        profileId: profile.id,
        photoId,
        // Begins with the agency and the profile, as the database requires.
        storageKey: `${actor.agencyId}/${profile.id}/${photoId}`,
      };
    });
  }

  /** Records the photo once its files are stored. It starts as waiting for review. */
  async attach(
    actor: ProfileActor,
    reservation: PhotoReservation,
    byteSize: number,
    correlationId: string,
    target: PhotoTarget = OWN,
  ): Promise<PhotoList> {
    this.requireRole(actor, target);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, target, true);
      // The reservation belongs to the profile it was made for.
      if (profile.id !== reservation.profileId) throw new AppError(409, 'PROFILE_STATE_INVALID');
      await this.requireRoom(unit, actor, profile.id);
      await unit.insert(
        actor.agencyId,
        profile.id,
        reservation.photoId,
        reservation.storageKey,
        byteSize,
        actor.accountId,
      );
      await unit.appendEvent(
        this.event('photo.uploaded', actor, reservation.photoId, correlationId),
      );
      return this.listOf(unit, actor, profile.id);
    });
  }

  /** Removes a photo. Returns the new list and the key whose files must now be deleted. */
  async remove(
    actor: ProfileActor,
    photoId: string,
    correlationId: string,
    target: PhotoTarget = OWN,
  ): Promise<{ list: PhotoList; storageKey: string }> {
    this.requireRole(actor, target);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, target, true);
      const photo = await unit.find(actor.agencyId, profile.id, photoId);
      if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND');

      await unit.remove(actor.agencyId, photo.id);
      // The main photo went: the next approved one takes its place.
      if (photo.isPrimary) await unit.promoteNext(actor.agencyId, profile.id);
      await unit.appendEvent(this.event('photo.removed', actor, photo.id, correlationId));
      return { list: await this.listOf(unit, actor, profile.id), storageKey: photo.storageKey };
    });
  }

  async makePrimary(
    actor: ProfileActor,
    photoId: string,
    target: PhotoTarget = OWN,
  ): Promise<PhotoList> {
    this.requireRole(actor, target);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, target, true);
      const photo = await unit.find(actor.agencyId, profile.id, photoId);
      if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND');
      // Only a photo others can see may be the one shown first.
      if (photo.status !== 'published') throw new AppError(409, 'PHOTO_NOT_APPROVED');
      await unit.makePrimary(actor.agencyId, profile.id, photo.id);
      return this.listOf(unit, actor, profile.id);
    });
  }

  /** Who sees the photos clearly: everyone released the profile to, or only people with an accepted proposal. */
  async setPrivacy(
    actor: ProfileActor,
    privacy: PhotoPrivacy,
    correlationId: string,
    target: PhotoTarget = OWN,
  ): Promise<PhotoList> {
    this.requireRole(actor, target);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, target, true);
      await unit.setPrivacy(actor.agencyId, profile.id, privacy);
      await unit.appendEvent(this.event('photo.privacy_changed', actor, profile.id, correlationId));
      return this.listOf(unit, actor, profile.id);
    });
  }

  /** Where the files of one of the client's photos are. The client and their staff may see waiting photos. */
  async locate(
    actor: ProfileActor,
    photoId: string,
    target: PhotoTarget = OWN,
  ): Promise<{ storageKey: string }> {
    this.requireRole(actor, target);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, target, false);
      const photo = await unit.find(actor.agencyId, profile.id, photoId);
      if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND');
      return { storageKey: photo.storageKey };
    });
  }

  // A member's own photos are for members; a client's photos are for staff (anyone else is turned away).
  private requireRole(actor: ProfileActor, target: PhotoTarget) {
    const allowed = target.kind === 'own' ? actor.role === 'member' : actor.role !== 'member';
    if (!allowed || (target.kind === 'client' && actor.role === 'guardian'))
      throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  /** The profile the actor works on, or null; staff who do not look after the client get "not found". */
  private async find(unit: PhotoUnit, actor: ProfileActor, target: PhotoTarget, lock: boolean) {
    if (target.kind === 'own') return unit.profileOf(actor.agencyId, actor.accountId, lock);
    const profile = await unit.clientProfile(actor.agencyId, target.profileId, lock);
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  private async mustHaveProfile(
    unit: PhotoUnit,
    actor: ProfileActor,
    target: PhotoTarget,
    lock: boolean,
  ) {
    const profile = await this.find(unit, actor, target, lock);
    if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
    // A closed profile is kept for the record and is no longer changed.
    if (profile.status === 'closed') throw new AppError(409, 'PROFILE_STATE_INVALID');
    return profile;
  }

  private async requireRoom(unit: PhotoUnit, actor: ProfileActor, profileId: string) {
    if ((await unit.count(actor.agencyId, profileId)) >= MAX_PHOTOS) {
      throw new AppError(409, 'PHOTO_LIMIT_REACHED');
    }
  }

  private async listOf(
    unit: PhotoUnit,
    actor: ProfileActor,
    profileId: string,
  ): Promise<PhotoList> {
    return {
      photos: await unit.list(actor.agencyId, profileId),
      limit: MAX_PHOTOS,
      privacy: await unit.privacy(actor.agencyId, profileId),
    };
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    photoId: string,
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
      subjectId: photoId,
    };
  }
}
