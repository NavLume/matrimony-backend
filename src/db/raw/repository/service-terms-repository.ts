import type { ServiceTerms, ServiceTermsInput } from '../../../bo/service-terms.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

export interface TermsProfile {
  id: string;
  memberCode: string;
  fullName: string;
  assignedAgentId: string | null;
  ownerAccountId: string | null;
}

const profileOf = (row: Row | undefined): TermsProfile | null =>
  row
    ? {
        id: row.id as string,
        memberCode: row.member_code as string,
        fullName: row.full_name as string,
        assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
        ownerAccountId: (row.owner_account_id as string | null) ?? null,
      }
    : null;

const COLUMNS = `t.version, t.coverage, t.introductions, t.refund_rule, t.created_at,
       c.display_name AS recorded_by, t.acknowledged_at, t.acknowledged_how, k.display_name AS acknowledged_by`;
const FROM = `FROM matrimony.client_service_terms t
  JOIN matrimony.accounts c ON c.agency_id = t.agency_id AND c.id = t.created_by
  LEFT JOIN matrimony.accounts k ON k.agency_id = t.agency_id AND k.id = t.acknowledged_by`;

const termsOf = (row: Row): ServiceTerms => ({
  version: Number(row.version),
  coverage: row.coverage as string,
  introductions: row.introductions === null ? null : Number(row.introductions),
  refundRule: row.refund_rule as string,
  recordedBy: row.recorded_by as string,
  recordedAt: (row.created_at as Date).toISOString(),
  acknowledged: row.acknowledged_at
    ? {
        at: (row.acknowledged_at as Date).toISOString(),
        by: row.acknowledged_by as string,
        how: row.acknowledged_how as 'client' | 'office',
      }
    : null,
});

/** The recorded terms of a client's service. A version is never changed or deleted. */
export class ServiceTermsRepository {
  async profileById(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT id, member_code, full_name, assigned_agent_id, owner_account_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    return profileOf(result.rows[0] as Row | undefined);
  }

  async ownProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT id, member_code, full_name, assigned_agent_id, owner_account_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND owner_account_id = $2`,
      [agencyId, accountId],
    );
    return profileOf(result.rows[0] as Row | undefined);
  }

  /** Every version, newest first. */
  async versions(tx: Transaction, agencyId: string, profileId: string): Promise<ServiceTerms[]> {
    const result = await tx.query(
      `SELECT ${COLUMNS} ${FROM}
        WHERE t.agency_id = $1 AND t.profile_id = $2 ORDER BY t.version DESC`,
      [agencyId, profileId],
    );
    return (result.rows as Row[]).map(termsOf);
  }

  /** Adds the next version (the client's earlier confirmation does not carry over to it). */
  async insert(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    input: ServiceTermsInput,
    by: string,
  ): Promise<number> {
    const result = await tx.query(
      `INSERT INTO matrimony.client_service_terms
         (agency_id, profile_id, version, coverage, introductions, refund_rule, created_by)
       SELECT $1, $2, coalesce(max(version), 0) + 1, $3, $4, $5, $6
         FROM matrimony.client_service_terms WHERE agency_id = $1 AND profile_id = $2
       RETURNING version`,
      [agencyId, profileId, input.coverage, input.introductions, input.refundRule, by],
    );
    return Number((result.rows[0] as Row).version);
  }

  /** Confirms the newest version, once. False when there is none or it was already confirmed. */
  async acknowledge(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    by: string,
    how: 'client' | 'office',
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.client_service_terms
          SET acknowledged_at = now(), acknowledged_by = $3, acknowledged_how = $4
        WHERE agency_id = $1 AND profile_id = $2 AND acknowledged_at IS NULL
          AND version = (SELECT max(version) FROM matrimony.client_service_terms
                          WHERE agency_id = $1 AND profile_id = $2)`,
      [agencyId, profileId, by, how],
    );
    return result.rowCount === 1;
  }
}
