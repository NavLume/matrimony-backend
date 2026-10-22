import type { WorkflowEvent } from '../../bo/event.js';
import type { PhotoFile, PhotoPrivacy, PhotoRecord } from '../../bo/photo.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { PhotoRepository } from '../raw/repository/photo-repository.js';

/**
 * Everything the photo workflow may do, bound to one open transaction. The rules run between
 * these calls inside the same transaction, so a limit that is checked cannot be overtaken by a
 * second upload, and an event is stored together with its change.
 */
export interface PhotoUnit {
  /** The member's profile; `lock` holds it until the transaction ends. Null when there is none. */
  profileOf(
    agencyId: string,
    ownerId: string,
    lock: boolean,
  ): Promise<{ id: string; status: string } | null>;
  /** A client's profile by id, with who looks after it (for staff). Null when there is none. */
  clientProfile(
    agencyId: string,
    profileId: string,
    lock: boolean,
  ): Promise<{ id: string; status: string; assignedAgentId: string | null } | null>;
  list(agencyId: string, profileId: string): Promise<PhotoRecord[]>;
  /** Who sees this profile's photos clearly. */
  privacy(agencyId: string, profileId: string): Promise<PhotoPrivacy>;
  setPrivacy(agencyId: string, profileId: string, privacy: PhotoPrivacy): Promise<void>;
  find(agencyId: string, profileId: string, photoId: string): Promise<PhotoFile | null>;
  count(agencyId: string, profileId: string): Promise<number>;
  /** Adds the photo as waiting for review. */
  insert(
    agencyId: string,
    profileId: string,
    photoId: string,
    storageKey: string,
    byteSize: number,
    uploadedBy: string,
    /** A fingerprint of the processed photo, so the same picture on two profiles can be noticed. */
    contentHash?: string | null,
  ): Promise<void>;
  remove(agencyId: string, photoId: string): Promise<void>;
  makePrimary(agencyId: string, profileId: string, photoId: string): Promise<void>;
  promoteNext(agencyId: string, profileId: string): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class PhotoDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: PhotoRepository,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: PhotoUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): PhotoUnit {
    const repo = this.repository;
    return {
      profileOf: (agencyId, ownerId, lock) => repo.profileOf(tx, agencyId, ownerId, lock),
      clientProfile: (agencyId, profileId, lock) =>
        repo.clientProfile(tx, agencyId, profileId, lock),
      list: (agencyId, profileId) => repo.list(tx, agencyId, profileId),
      privacy: (agencyId, profileId) => repo.privacy(tx, agencyId, profileId),
      setPrivacy: (agencyId, profileId, privacy) =>
        repo.setPrivacy(tx, agencyId, profileId, privacy),
      find: (agencyId, profileId, photoId) => repo.find(tx, agencyId, profileId, photoId),
      count: (agencyId, profileId) => repo.count(tx, agencyId, profileId),
      insert: (agencyId, profileId, photoId, key, size, by, hash) =>
        repo.insert(tx, agencyId, profileId, photoId, key, size, by, hash ?? null),
      remove: (agencyId, photoId) => repo.remove(tx, agencyId, photoId),
      makePrimary: (agencyId, profileId, photoId) =>
        repo.makePrimary(tx, agencyId, profileId, photoId),
      promoteNext: (agencyId, profileId) => repo.promoteNext(tx, agencyId, profileId),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
