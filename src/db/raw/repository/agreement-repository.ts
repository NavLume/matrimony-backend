import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

/** The versions of the terms and privacy text a person agreed to, and a new agreement. */
export class AgreementRepository {
  /** The latest version of each text this account agreed to. */
  async accepted(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT DISTINCT ON (purpose) purpose, document_version
         FROM matrimony.consent_events
        WHERE agency_id = $1 AND account_id = $2 AND purpose IN ('terms', 'privacy') AND action = 'accepted'
        ORDER BY purpose, created_at DESC, id DESC`,
      [agencyId, accountId],
    );
    const found: { terms: string | null; privacy: string | null } = { terms: null, privacy: null };
    for (const row of result.rows as Row[])
      found[row.purpose as 'terms' | 'privacy'] = row.document_version as string;
    return found;
  }

  async record(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    purpose: 'terms' | 'privacy',
    version: string,
  ) {
    await tx.query(
      `INSERT INTO matrimony.consent_events (agency_id, account_id, purpose, document_version, action)
       VALUES ($1, $2, $3, $4, 'accepted')`,
      [agencyId, accountId, purpose, version],
    );
  }
}
