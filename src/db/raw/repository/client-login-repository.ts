import type { Account } from '../../../bo/identity.js';
import type { Transaction } from '../../config/database.js';
import { accountRow } from '../../entity/identity.js';
import { mapAccount } from '../mapper/identity.js';
import { clientLoginQueries } from '../query/client-login.js';
import { registrationQueries } from '../query/registration.js';

export interface LoginProfile {
  id: string;
  fullName: string;
  serviceMode: 'self_service' | 'assisted';
  ownerAccountId: string | null;
  ownerName: string | null;
  assignedAgentId: string | null;
}

export interface OpenLogin {
  id: string;
  channel: 'sms' | 'email';
  email: string | null;
  phone: string | null;
  locale: 'bn' | 'en';
  expiresAt: string;
  expired: boolean;
  invitedByName: string;
}

export interface LinkedLogin {
  id: string;
  profileId: string;
  channel: 'sms' | 'email';
  email: string | null;
  phone: string | null;
  locale: 'bn' | 'en';
  fullName: string;
  ownerAccountId: string | null;
  serviceMode: 'self_service' | 'assisted';
}

type Row = Record<string, unknown>;

/** The links that give a client a login, and the profile each is for. Runs in the transaction it is given. */
export class ClientLoginRepository {
  async profile(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    lock: boolean,
  ): Promise<LoginProfile | null> {
    const result = await tx.query(
      lock ? clientLoginQueries.profileForUpdate : clientLoginQueries.profile,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      fullName: row.full_name as string,
      serviceMode: row.service_mode as LoginProfile['serviceMode'],
      ownerAccountId: (row.owner_account_id as string | null) ?? null,
      ownerName: (row.owner_name as string | null) ?? null,
      assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
    };
  }

  async open(tx: Transaction, agencyId: string, profileId: string): Promise<OpenLogin | null> {
    const result = await tx.query(clientLoginQueries.open, [agencyId, profileId]);
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      channel: row.channel as OpenLogin['channel'],
      email: (row.email as string | null) ?? null,
      phone: (row.phone_e164 as string | null) ?? null,
      locale: row.locale as OpenLogin['locale'],
      expiresAt: (row.expires_at as Date).toISOString(),
      expired: row.expired === true,
      invitedByName: row.invited_by_name as string,
    };
  }

  async byLink(
    tx: Transaction,
    agencyId: string,
    tokenHash: string,
    lock: boolean,
  ): Promise<LinkedLogin | null> {
    const sql = lock ? `${clientLoginQueries.byLink} FOR UPDATE OF l` : clientLoginQueries.byLink;
    const result = await tx.query(sql, [agencyId, tokenHash]);
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      profileId: row.profile_id as string,
      channel: row.channel as LinkedLogin['channel'],
      email: (row.email as string | null) ?? null,
      phone: (row.phone_e164 as string | null) ?? null,
      locale: row.locale as LinkedLogin['locale'],
      fullName: row.full_name as string,
      ownerAccountId: (row.owner_account_id as string | null) ?? null,
      serviceMode: row.service_mode as LinkedLogin['serviceMode'],
    };
  }

  /** Puts a new link in place of any link still out for the profile. */
  async replaceLink(
    tx: Transaction,
    agencyId: string,
    link: {
      profileId: string;
      channel: 'sms' | 'email';
      email: string | null;
      phone: string | null;
      locale: 'bn' | 'en';
      tokenHash: string;
      days: number;
      createdBy: string;
    },
  ): Promise<string> {
    await tx.query(clientLoginQueries.revokeOpen, [agencyId, link.profileId]);
    const result = await tx.query(clientLoginQueries.insert, [
      agencyId,
      link.profileId,
      link.channel,
      link.email,
      link.phone,
      link.locale,
      link.tokenHash,
      link.days,
      link.createdBy,
    ]);
    return (result.rows[0] as Row).id as string;
  }

  /** True when a link was open and is now cancelled. */
  async revokeOpen(tx: Transaction, agencyId: string, profileId: string): Promise<boolean> {
    const result = await tx.query(clientLoginQueries.revokeOpen, [agencyId, profileId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * The member account for the client: role fixed here, signed in locally, with the address the link
   * reached marked as proven. Null when another account already uses the address.
   */
  async createAccount(
    tx: Transaction,
    agencyId: string,
    account: {
      id: string;
      displayName: string;
      channel: 'sms' | 'email';
      email: string | null;
      phone: string | null;
      locale: 'bn' | 'en';
    },
  ): Promise<Account | null> {
    const result =
      account.channel === 'email'
        ? await tx.query(registrationQueries.insertAccount, [
            agencyId,
            account.id,
            account.displayName,
            account.email,
            account.locale,
          ])
        : await tx.query(registrationQueries.insertPhoneAccount, [
            agencyId,
            account.id,
            account.displayName,
            account.phone,
            account.locale,
          ]);
    return result.rows[0] ? mapAccount(accountRow.parse(result.rows[0])) : null;
  }

  async attachOwner(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(clientLoginQueries.attachOwner, [agencyId, profileId, accountId]);
    return result.rows.length > 0;
  }

  async markAccepted(
    tx: Transaction,
    agencyId: string,
    linkId: string,
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(clientLoginQueries.markAccepted, [agencyId, linkId, accountId]);
    return result.rowCount === 1;
  }
}
