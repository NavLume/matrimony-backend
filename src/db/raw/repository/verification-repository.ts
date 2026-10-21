import type {
  DocumentMime,
  DocumentType,
  VerificationRequest,
  VerificationStatus,
  VerificationWaiting,
} from '../../../bo/verification.js';
import type { Transaction } from '../../config/database.js';

export interface VerificationProfile {
  id: string;
  memberCode: string;
  fullName: string;
  status: string;
  assignedAgentId: string | null;
  ownerAccountId: string | null;
  verifiedAt: string | null;
  verifiedChecks: string[];
}

export interface StoredRequest {
  row: VerificationRequest;
  fileKey: string;
  profileId: string;
  submittedBy: string;
  fileRemoved: boolean;
}

type Row = Record<string, unknown>;

const PROFILE_COLUMNS = `id, member_code, full_name, status, assigned_agent_id, owner_account_id, verified_at, verified_checks`;

const profileOf = (row: Row | undefined): VerificationProfile | null =>
  row
    ? {
        id: row.id as string,
        memberCode: row.member_code as string,
        fullName: row.full_name as string,
        status: row.status as string,
        assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
        ownerAccountId: (row.owner_account_id as string | null) ?? null,
        verifiedAt: row.verified_at ? (row.verified_at as Date).toISOString() : null,
        verifiedChecks: (row.verified_checks as string[] | null) ?? [],
      }
    : null;

const REQUEST_COLUMNS = `id, profile_id, doc_type, file_key, status, submitted_by, submitted_at,
       decided_at, decision_note, file_removed_at`;

const requestOf = (row: Row): StoredRequest => ({
  row: {
    id: row.id as string,
    docType: row.doc_type as DocumentType,
    status: row.status as VerificationStatus,
    submittedAt: (row.submitted_at as Date).toISOString(),
    decidedAt: row.decided_at ? (row.decided_at as Date).toISOString() : null,
    note: (row.decision_note as string | null) ?? null,
    // The file goes at the decision, a moment after the row changes, so a decided request has none.
    hasFile: row.status === 'pending' && row.file_removed_at === null,
  },
  fileKey: row.file_key as string,
  profileId: row.profile_id as string,
  submittedBy: row.submitted_by as string,
  fileRemoved: row.file_removed_at !== null,
});

/** Identity-verification requests and the mark on a profile. Never deletes a row. */
export class VerificationRepository {
  async profileById(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT ${PROFILE_COLUMNS} FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    return profileOf(result.rows[0]);
  }

  async ownProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT ${PROFILE_COLUMNS} FROM matrimony.member_profiles
        WHERE agency_id = $1 AND owner_account_id = $2`,
      [agencyId, accountId],
    );
    return profileOf(result.rows[0]);
  }

  /** The newest request of a profile. */
  async latest(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT ${REQUEST_COLUMNS} FROM matrimony.profile_verifications
        WHERE agency_id = $1 AND profile_id = $2 ORDER BY submitted_at DESC LIMIT 1`,
      [agencyId, profileId],
    );
    return result.rows[0] ? requestOf(result.rows[0]) : null;
  }

  async byId(tx: Transaction, agencyId: string, id: string) {
    const result = await tx.query(
      `SELECT ${REQUEST_COLUMNS} FROM matrimony.profile_verifications
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
    return result.rows[0] ? requestOf(result.rows[0]) : null;
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    request: {
      id: string;
      profileId: string;
      docType: DocumentType;
      key: string;
      mime: DocumentMime;
      size: number;
      submittedBy: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.profile_verifications
         (agency_id, id, profile_id, doc_type, file_key, file_mime, file_size, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        agencyId,
        request.id,
        request.profileId,
        request.docType,
        request.key,
        request.mime,
        request.size,
        request.submittedBy,
      ],
    );
  }

  /** The type of the stored file, to send it with the right header. */
  async mimeOf(tx: Transaction, agencyId: string, id: string): Promise<DocumentMime | null> {
    const result = await tx.query(
      `SELECT file_mime FROM matrimony.profile_verifications WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
    return (result.rows[0]?.file_mime as DocumentMime | undefined) ?? null;
  }

  /** Decides a waiting request. False when it was not waiting any more. */
  async decide(
    tx: Transaction,
    agencyId: string,
    id: string,
    status: Exclude<VerificationStatus, 'pending'>,
    deciderId: string,
    note: string | null,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.profile_verifications
          SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
        WHERE agency_id = $1 AND id = $2 AND status = 'pending'
`,
      [agencyId, id, status, deciderId, note],
    );
    return result.rowCount === 1;
  }

  async markFileRemoved(tx: Transaction, agencyId: string, id: string): Promise<void> {
    await tx.query(
      `UPDATE matrimony.profile_verifications SET file_removed_at = now()
        WHERE agency_id = $1 AND id = $2 AND file_removed_at IS NULL`,
      [agencyId, id],
    );
  }

  /**
   * Puts the mark on a profile with the checks that were made (identity is always one of them), or takes it
   * off (`by` null, which also clears the checks).
   */
  async setVerified(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    by: string | null,
    checks: readonly string[] = [],
  ): Promise<void> {
    const all = by === null ? [] : ['identity', ...checks.filter((check) => check !== 'identity')];
    await tx.query(
      `UPDATE matrimony.member_profiles
          SET verified_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END, verified_by = $3,
              verified_checks = $4::text[]
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId, by, all],
    );
  }

  /** Records the checks on the request that was just decided, for the history. */
  async setRequestChecks(
    tx: Transaction,
    agencyId: string,
    requestId: string,
    checks: readonly string[],
  ): Promise<void> {
    await tx.query(
      `UPDATE matrimony.profile_verifications SET checks = $3::text[] WHERE agency_id = $1 AND id = $2`,
      [agencyId, requestId, ['identity', ...checks]],
    );
  }

  /** Changes the optional checks of a verified profile (identity stays). */
  async setChecks(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    checks: readonly string[],
  ): Promise<void> {
    await tx.query(
      `UPDATE matrimony.member_profiles SET verified_checks = $3::text[]
        WHERE agency_id = $1 AND id = $2 AND verified_at IS NOT NULL`,
      [agencyId, profileId, ['identity', ...checks]],
    );
  }

  /** Requests waiting for a decision, oldest first. An agent sees only those of their own clients. */
  async waiting(
    tx: Transaction,
    agencyId: string,
    agentId: string | null,
  ): Promise<VerificationWaiting[]> {
    const result = await tx.query(
      `SELECT v.id, v.doc_type, v.submitted_at, p.id AS profile_id, p.member_code, p.full_name,
              a.display_name AS submitted_by_name
         FROM matrimony.profile_verifications v
         JOIN matrimony.member_profiles p ON p.agency_id = v.agency_id AND p.id = v.profile_id
         JOIN matrimony.accounts a ON a.agency_id = v.agency_id AND a.id = v.submitted_by
        WHERE v.agency_id = $1 AND v.status = 'pending'
          AND ($2::uuid IS NULL OR p.assigned_agent_id = $2::uuid)
        ORDER BY v.submitted_at ASC
        LIMIT 200`,
      [agencyId, agentId],
    );
    return result.rows.map((row: Row) => ({
      id: row.id as string,
      profile: {
        id: row.profile_id as string,
        memberCode: row.member_code as string,
        fullName: row.full_name as string,
      },
      docType: row.doc_type as DocumentType,
      submittedAt: (row.submitted_at as Date).toISOString(),
      submittedBy: row.submitted_by_name as string,
    }));
  }
}
