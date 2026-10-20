import type { CvRecord, CvStatus } from '../../../bo/cv.js';
import type { Transaction } from '../../config/database.js';
import { cvQueries } from '../query/cv.js';
import { notifyDecided, notifyReviewers } from './notice.js';

type Row = Record<string, unknown>;

/** A profile as the CV rules need it. */
export interface CvProfile {
  id: string;
  status: string;
  serviceMode: 'self_service' | 'assisted';
  assignedAgentId: string | null;
}

const profile = (row: Row): CvProfile => ({
  id: row.id as string,
  status: row.status as string,
  serviceMode: row.service_mode as CvProfile['serviceMode'],
  assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
});

const record = (row: Row): CvRecord => ({
  id: row.id as string,
  storageKey: row.storage_key as string,
  fileName: row.file_name as string,
  byteSize: row.byte_size as number,
  status: row.status as CvStatus,
  uploadedAt: (row.created_at as Date).toISOString(),
  uploadedByStaff: row.by_staff === true,
  reviewerNotes: (row.reviewer_notes as string | null) ?? null,
});

/** All CV reads and writes. Every method runs inside the transaction it is given. */
export class CvRepository {
  async ownProfile(
    tx: Transaction,
    agencyId: string,
    ownerId: string,
    lock: boolean,
  ): Promise<CvProfile | null> {
    const result = await tx.query(lock ? cvQueries.lockOwnProfile : cvQueries.ownProfile, [
      agencyId,
      ownerId,
    ]);
    return result.rows[0] ? profile(result.rows[0] as Row) : null;
  }

  /** The profile a guardian account looks after, while the guardian link is active. */
  async guardedProfile(
    tx: Transaction,
    agencyId: string,
    accountId: string,
  ): Promise<CvProfile | null> {
    const result = await tx.query(cvQueries.guardedProfile, [agencyId, accountId]);
    return result.rows[0] ? profile(result.rows[0] as Row) : null;
  }

  async profileById(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    lock: boolean,
  ): Promise<CvProfile | null> {
    const result = await tx.query(lock ? cvQueries.lockProfile : cvQueries.profile, [
      agencyId,
      profileId,
    ]);
    return result.rows[0] ? profile(result.rows[0] as Row) : null;
  }

  async live(tx: Transaction, agencyId: string, profileId: string): Promise<CvRecord[]> {
    const result = await tx.query(cvQueries.live, [agencyId, profileId]);
    return result.rows.map((row) => record(row as Row));
  }

  async published(tx: Transaction, agencyId: string, profileId: string): Promise<CvRecord | null> {
    const result = await tx.query(cvQueries.published, [agencyId, profileId]);
    return result.rows[0] ? record(result.rows[0] as Row) : null;
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    input: {
      id: string;
      profileId: string;
      storageKey: string;
      fileName: string;
      byteSize: number;
      status: 'pending' | 'published';
      uploadedBy: string;
    },
  ): Promise<void> {
    await tx.query(cvQueries.insert, [
      agencyId,
      input.id,
      input.profileId,
      input.storageKey,
      input.fileName,
      input.byteSize,
      input.status,
      input.uploadedBy,
    ]);
    // A member's CV waits for review: whoever reviews it is told.
    if (input.status === 'pending') {
      await notifyReviewers(tx, agencyId, input.profileId, input.uploadedBy, 'cv');
    }
  }

  async markRemoved(tx: Transaction, agencyId: string, id: string): Promise<void> {
    await tx.query(cvQueries.markRemoved, [agencyId, id]);
  }

  async decide(
    tx: Transaction,
    agencyId: string,
    id: string,
    approve: boolean,
    reviewerId: string,
    notes: string | null,
  ): Promise<boolean> {
    const result = await tx.query(cvQueries.decide, [agencyId, id, approve, reviewerId, notes]);
    const row = result.rows[0] as
      { profile_id: string; uploaded_by_account_id: string } | undefined;
    if (!row) return false;
    await notifyDecided(
      tx,
      agencyId,
      row.profile_id,
      row.uploaded_by_account_id,
      reviewerId,
      'cv',
      approve ? 'approved' : 'rejected',
    );
    return true;
  }

  async accepted(tx: Transaction, agencyId: string, a: string, b: string): Promise<boolean> {
    const result = await tx.query(cvQueries.accepted, [agencyId, a, b]);
    return result.rows.length > 0;
  }
}
