import type { Transaction } from '../../config/database.js';

export interface DeletionAccount {
  role: 'admin' | 'agent' | 'member' | 'guardian';
  email: string | null;
  phone: string | null;
  hasPassword: boolean;
  erased: boolean;
}

/** A file to delete after an erasure: a photo has size variants, a file is one object. A null key is only 'this account was erased'. */
export interface ErasedRow {
  account_id: string;
  file_key: string | null;
  file_kind: 'photo' | 'file' | null;
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
      `SELECT erased_account_id AS account_id, erased_file_key AS file_key, erased_file_kind AS file_kind
         FROM matrimony.erase_due_members($1, $2, $3)`,
      [agencyId, before.toISOString(), limit],
    );
    return result.rows as ErasedRow[];
  }
  /** Schedules the erasure of a client with no login. Null when the profile is not eligible or is already scheduled. */
  async scheduleClient(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    actorId: string,
    reason: string,
  ) {
    const result = await tx.query(
      'SELECT matrimony.schedule_client_erasure($1, $2, $3, $4) AS scheduled',
      [agencyId, profileId, actorId, reason],
    );
    const value = (result.rows[0] as { scheduled: Date | null } | undefined)?.scheduled;
    return value ? new Date(value) : null;
  }
  async cancelClient(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query('SELECT matrimony.cancel_client_erasure($1, $2) AS done', [
      agencyId,
      profileId,
    ]);
    return (result.rows[0] as { done: boolean } | undefined)?.done === true;
  }
  /** The clients whose waiting time is over, erased now. A row with no file marks one profile. */
  async eraseDueClients(tx: Transaction, agencyId: string, before: Date, limit: number) {
    const result = await tx.query(
      `SELECT erased_profile_id AS profile_id, erased_file_key AS file_key, erased_file_kind AS file_kind
         FROM matrimony.erase_due_clients($1, $2, $3)`,
      [agencyId, before.toISOString(), limit],
    );
    return result.rows as (Omit<ErasedRow, 'account_id'> & { profile_id: string })[];
  }
}
