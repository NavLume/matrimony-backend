import type { Transaction } from '../../config/database.js';

export interface DeletionAccount {
  role: 'admin' | 'agent' | 'member' | 'guardian';
  email: string | null;
  phone: string | null;
  hasPassword: boolean;
  erased: boolean;
}

interface AccountRow {
  role: DeletionAccount['role'];
  email: string | null;
  phone_e164: string | null;
  erased: boolean;
  has_password: boolean;
}

/**
 * A member deleting their own account. The work is done by the database functions of migration 027,
 * which run with the owner's rights; the runtime role can neither delete rows nor edit most columns.
 */
export class AccountDeletionRepository {
  async account(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT a.role, a.email, a.phone_e164, a.erased_at IS NOT NULL AS erased,
              EXISTS (SELECT 1 FROM matrimony.account_credentials c
                       WHERE c.agency_id = a.agency_id AND c.account_id = a.id) AS has_password
         FROM matrimony.accounts a WHERE a.agency_id = $1 AND a.id = $2`,
      [agencyId, accountId],
    );
    const row = result.rows[0] as AccountRow | undefined;
    if (!row) return null;
    return {
      role: row.role,
      email: row.email,
      phone: row.phone_e164,
      hasPassword: row.has_password,
      erased: row.erased,
    } satisfies DeletionAccount;
  }
  async request(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query('SELECT matrimony.request_member_deletion($1, $2) AS requested', [
      agencyId,
      accountId,
    ]);
    const value = (result.rows[0] as { requested: Date | null } | undefined)?.requested;
    return value ? new Date(value) : null;
  }
  async cancel(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query('SELECT matrimony.cancel_member_deletion($1, $2) AS done', [
      agencyId,
      accountId,
    ]);
    return (result.rows[0] as { done: boolean } | undefined)?.done === true;
  }
  async eraseDue(tx: Transaction, agencyId: string, before: Date, limit: number) {
    const result = await tx.query(
      'SELECT erased_account_id AS account_id, erased_storage_key AS storage_key FROM matrimony.erase_due_members($1, $2, $3)',
      [agencyId, before.toISOString(), limit],
    );
    return result.rows as { account_id: string; storage_key: string }[];
  }
}
