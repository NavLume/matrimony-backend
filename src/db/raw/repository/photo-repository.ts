import type { PhotoFile, PhotoPrivacy, PhotoRecord } from '../../../bo/photo.js';
import type { Transaction } from '../../config/database.js';
import { profileRef } from '../../entity/photo.js';
import { mapPhoto, mapPhotoFile } from '../mapper/photo.js';
import { photoQueries } from '../query/photo.js';
import { notifyReviewers } from './notice.js';

/** All photo reads and writes. Every method runs inside the transaction it is given. */
export class PhotoRepository {
  /** The member's profile (id and status), locked when `lock` is set. Null when they have none. */
  async profileOf(tx: Transaction, agencyId: string, ownerId: string, lock: boolean) {
    const result = await tx.query(lock ? photoQueries.lockProfile : photoQueries.findProfile, [
      agencyId,
      ownerId,
    ]);
    return result.rows[0] ? profileRef.parse(result.rows[0]) : null;
  }

  /** A client's profile by id, with who looks after it, locked when `lock` is set. Null when there is none. */
  async clientProfile(tx: Transaction, agencyId: string, profileId: string, lock: boolean) {
    const result = await tx.query(
      lock ? photoQueries.lockClientProfile : photoQueries.findClientProfile,
      [agencyId, profileId],
    );
    const row = result.rows[0] as
      { id: string; status: string; assigned_agent_id: string | null } | undefined;
    return row
      ? { id: row.id, status: row.status, assignedAgentId: row.assigned_agent_id ?? null }
      : null;
  }

  async privacy(tx: Transaction, agencyId: string, profileId: string): Promise<PhotoPrivacy> {
    const result = await tx.query(photoQueries.privacy, [agencyId, profileId]);
    return ((result.rows[0] as { photo_privacy: string } | undefined)?.photo_privacy ??
      'clear') as PhotoPrivacy;
  }

  async setPrivacy(tx: Transaction, agencyId: string, profileId: string, privacy: PhotoPrivacy) {
    await tx.query(photoQueries.setPrivacy, [agencyId, profileId, privacy]);
  }

  async list(tx: Transaction, agencyId: string, profileId: string): Promise<PhotoRecord[]> {
    const result = await tx.query(photoQueries.list, [agencyId, profileId]);
    return result.rows.map(mapPhoto);
  }

  async find(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    photoId: string,
  ): Promise<PhotoFile | null> {
    const result = await tx.query(photoQueries.find, [agencyId, profileId, photoId]);
    return result.rows[0] ? mapPhotoFile(result.rows[0]) : null;
  }

  async count(tx: Transaction, agencyId: string, profileId: string): Promise<number> {
    const result = await tx.query(photoQueries.count, [agencyId, profileId]);
    return Number((result.rows[0] as { n: number }).n);
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    photoId: string,
    storageKey: string,
    byteSize: number,
    uploadedBy: string,
  ) {
    await tx.query(photoQueries.insert, [
      agencyId,
      photoId,
      profileId,
      storageKey,
      byteSize,
      uploadedBy,
    ]);
    await tx.query(photoQueries.insertReview, [agencyId, profileId, uploadedBy, photoId]);
    await notifyReviewers(tx, agencyId, profileId, uploadedBy, 'photo');
  }

  /** Removes the photo from the member's list and cancels any review waiting on it. */
  async remove(tx: Transaction, agencyId: string, photoId: string) {
    await tx.query(photoQueries.markRemoved, [agencyId, photoId]);
    await tx.query(photoQueries.cancelReview, [agencyId, photoId]);
  }

  async makePrimary(tx: Transaction, agencyId: string, profileId: string, photoId: string) {
    // The database allows one main photo per profile, so the old one must go first.
    await tx.query(photoQueries.clearPrimary, [agencyId, profileId]);
    await tx.query(photoQueries.setPrimary, [agencyId, photoId]);
  }

  async promoteNext(tx: Transaction, agencyId: string, profileId: string) {
    await tx.query(photoQueries.promoteNext, [agencyId, profileId]);
  }
}
