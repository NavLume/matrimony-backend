import { randomUUID } from 'node:crypto';
import type { AdviceKind } from '../../../bo/guardian.js';
import type { Account } from '../../../bo/identity.js';
import type { Transaction } from '../../config/database.js';
import { accountRow } from '../../entity/identity.js';
import { mapAccount } from '../mapper/identity.js';

type Row = Record<string, unknown>;

export interface GuardedProfile {
  id: string;
  fullName: string;
  memberCode: string;
  serviceMode: 'self_service' | 'assisted';
  ownerAccountId: string | null;
  assignedAgentId: string | null;
}

export interface GuardianRow {
  id: string;
  profileId: string;
  email: string;
  displayName: string;
  locale: 'bn' | 'en';
  status: 'awaiting_client' | 'invited' | 'active' | 'removed';
  consentBasis: 'client_in_app' | 'agent_recorded' | null;
  consentedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  accountId: string | null;
}

export interface LinkedGuardian {
  id: string;
  profileId: string;
  email: string;
  displayName: string;
  locale: 'bn' | 'en';
  clientName: string;
}

const PROFILE = `p.id, p.full_name, p.member_code, p.service_mode, p.owner_account_id, p.assigned_agent_id`;
const profileOf = (row: Row | undefined): GuardedProfile | null =>
  row
    ? {
        id: row.id as string,
        fullName: row.full_name as string,
        memberCode: row.member_code as string,
        serviceMode: row.service_mode as GuardedProfile['serviceMode'],
        ownerAccountId: (row.owner_account_id as string | null) ?? null,
        assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
      }
    : null;

const GUARDIAN = `g.id, g.profile_id, g.email, g.display_name, g.locale, g.status, g.consent_basis,
       g.consented_at, g.expires_at, (g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired, g.account_id`;
const guardianOf = (row: Row): GuardianRow => ({
  id: row.id as string,
  profileId: row.profile_id as string,
  email: row.email as string,
  displayName: row.display_name as string,
  locale: row.locale as GuardianRow['locale'],
  status: row.status as GuardianRow['status'],
  consentBasis: (row.consent_basis as GuardianRow['consentBasis']) ?? null,
  consentedAt: row.consented_at ? (row.consented_at as Date).toISOString() : null,
  expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
  expired: row.expired === true,
  accountId: (row.account_id as string | null) ?? null,
});

/** Guardians, the profile each looks after, and what they advised. Never deletes a row. */
export class GuardianRepository {
  async profile(tx: Transaction, agencyId: string, profileId: string, lock = false) {
    const result = await tx.query(
      `SELECT ${PROFILE} FROM matrimony.member_profiles p WHERE p.agency_id = $1 AND p.id = $2${lock ? ' FOR UPDATE' : ''}`,
      [agencyId, profileId],
    );
    return profileOf(result.rows[0]);
  }

  async ownProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT ${PROFILE} FROM matrimony.member_profiles p WHERE p.agency_id = $1 AND p.owner_account_id = $2`,
      [agencyId, accountId],
    );
    return profileOf(result.rows[0]);
  }

  /** The profile a guardian account looks after, while the link is active. */
  async guardedBy(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT ${PROFILE} FROM matrimony.profile_guardians g
         JOIN matrimony.member_profiles p ON p.agency_id = g.agency_id AND p.id = g.profile_id
        WHERE g.agency_id = $1 AND g.account_id = $2 AND g.status = 'active'`,
      [agencyId, accountId],
    );
    return profileOf(result.rows[0]);
  }

  /** The guardian of a profile that is not removed, if there is one. */
  async current(tx: Transaction, agencyId: string, profileId: string, lock = false) {
    const result = await tx.query(
      `SELECT ${GUARDIAN} FROM matrimony.profile_guardians g
        WHERE g.agency_id = $1 AND g.profile_id = $2 AND g.status <> 'removed'${lock ? ' FOR UPDATE' : ''}`,
      [agencyId, profileId],
    );
    return result.rows[0] ? guardianOf(result.rows[0]) : null;
  }

  async byLink(
    tx: Transaction,
    agencyId: string,
    tokenHash: string,
    lock: boolean,
  ): Promise<LinkedGuardian | null> {
    const result = await tx.query(
      `SELECT g.id, g.profile_id, g.email, g.display_name, g.locale, p.full_name AS client_name
         FROM matrimony.profile_guardians g
         JOIN matrimony.member_profiles p ON p.agency_id = g.agency_id AND p.id = g.profile_id
        WHERE g.agency_id = $1 AND g.token_hash = $2 AND g.status = 'invited' AND g.expires_at > now()${lock ? ' FOR UPDATE OF g' : ''}`,
      [agencyId, tokenHash],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          profileId: row.profile_id as string,
          email: row.email as string,
          displayName: row.display_name as string,
          locale: row.locale as 'bn' | 'en',
          clientName: row.client_name as string,
        }
      : null;
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    g: {
      profileId: string;
      email: string;
      displayName: string;
      locale: 'bn' | 'en';
      status: 'awaiting_client' | 'invited';
      consentBasis: 'client_in_app' | 'agent_recorded' | null;
      consentedBy: string | null;
      tokenHash: string | null;
      days: number;
      invitedBy: string;
    },
  ): Promise<string> {
    const result = await tx.query(
      `INSERT INTO matrimony.profile_guardians
         (agency_id, profile_id, email, display_name, locale, status, consent_basis, consented_at,
          consented_by, token_hash, expires_at, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END,
               $8::uuid, $9::text, CASE WHEN $9::text IS NULL THEN NULL ELSE now() + make_interval(days => $10::int) END, $11)
       RETURNING id`,
      [
        agencyId,
        g.profileId,
        g.email,
        g.displayName,
        g.locale,
        g.status,
        g.consentBasis,
        g.consentedBy,
        g.tokenHash,
        g.days,
        g.invitedBy,
      ],
    );
    return (result.rows[0] as Row).id as string;
  }

  /** The client agreed: the request becomes an invitation with a new link. */
  async consent(
    tx: Transaction,
    agencyId: string,
    id: string,
    basis: 'client_in_app' | 'agent_recorded',
    by: string,
    tokenHash: string,
    days: number,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.profile_guardians
          SET status = 'invited', consent_basis = $3, consented_at = now(), consented_by = $4,
              token_hash = $5, expires_at = now() + make_interval(days => $6::int)
        WHERE agency_id = $1 AND id = $2 AND status = 'awaiting_client'`,
      [agencyId, id, basis, by, tokenHash, days],
    );
    return result.rowCount === 1;
  }

  /** A new link for an invitation that is out or has expired. */
  async reissue(
    tx: Transaction,
    agencyId: string,
    id: string,
    tokenHash: string,
    days: number,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.profile_guardians
          SET token_hash = $3, expires_at = now() + make_interval(days => $4::int)
        WHERE agency_id = $1 AND id = $2 AND status = 'invited'`,
      [agencyId, id, tokenHash, days],
    );
    return result.rowCount === 1;
  }

  async remove(tx: Transaction, agencyId: string, id: string, by: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.profile_guardians
          SET status = 'removed', removed_at = now(), removed_by = $3, token_hash = NULL
        WHERE agency_id = $1 AND id = $2 AND status <> 'removed'`,
      [agencyId, id, by],
    );
    return result.rowCount === 1;
  }

  async markAccepted(
    tx: Transaction,
    agencyId: string,
    id: string,
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.profile_guardians
          SET status = 'active', account_id = $3, accepted_at = now(), token_hash = NULL
        WHERE agency_id = $1 AND id = $2 AND status = 'invited'`,
      [agencyId, id, accountId],
    );
    return result.rowCount === 1;
  }

  /** The guardian's account: role fixed here, signed in locally, the address the link reached proven. */
  async createAccount(
    tx: Transaction,
    agencyId: string,
    account: { id: string; displayName: string; email: string; locale: 'bn' | 'en' },
  ): Promise<Account | null> {
    const result = await tx.query(
      `INSERT INTO matrimony.accounts
         (agency_id, id, role, display_name, email, email_verified_at, auth_issuer, auth_subject, status, locale)
       VALUES ($1, $2::uuid, 'guardian', $3, $4, now(), 'local', ($2::uuid)::text, 'active', $5)
       ON CONFLICT DO NOTHING RETURNING id, agency_id, role, display_name`,
      [agencyId, account.id, account.displayName, account.email, account.locale],
    );
    return result.rows[0] ? mapAccount(accountRow.parse(result.rows[0])) : null;
  }

  async accountExists(tx: Transaction, agencyId: string, email: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM matrimony.accounts WHERE agency_id = $1 AND email = $2`,
      [agencyId, email],
    );
    return result.rows.length > 0;
  }

  /** A proposal the client received, for advice. */
  async receivedProposal(tx: Transaction, agencyId: string, interestId: string, profileId: string) {
    const result = await tx.query(
      `SELECT status FROM matrimony.interests
        WHERE agency_id = $1 AND id = $2 AND recipient_profile_id = $3`,
      [agencyId, interestId, profileId],
    );
    return (result.rows[0]?.status as string | undefined) ?? null;
  }

  async saveAdvice(
    tx: Transaction,
    agencyId: string,
    interestId: string,
    profileId: string,
    advice: AdviceKind,
    note: string | null,
    by: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.guardian_advice (agency_id, interest_id, profile_id, advice, note, advised_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agency_id, interest_id, profile_id)
       DO UPDATE SET advice = EXCLUDED.advice, note = EXCLUDED.note,
                     advised_by = EXCLUDED.advised_by, advised_at = now()`,
      [agencyId, interestId, profileId, advice, note, by],
    );
  }

  /** Tells the client, who signs in, that their agency asked for a guardian and waits for their answer. */
  async notifyClientApproval(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    guardianId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       SELECT $1, p.owner_account_id, $3::text,
              'guardian.requested', jsonb_build_object('forProfileId', p.id, 'aboutProfileId', p.id)
         FROM matrimony.member_profiles p
        WHERE p.agency_id = $1 AND p.id = $2 AND p.owner_account_id IS NOT NULL`,
      [agencyId, profileId, `guardian-request:${guardianId}:${randomUUID()}`],
    );
  }

  /** Tells the client and the agent who looks after them that the guardian gave advice. */
  async notifyAdvice(
    tx: Transaction,
    agencyId: string,
    interestId: string,
    profileId: string,
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       SELECT $1, w.account_id, $5::text,
              'guardian.advice',
              jsonb_build_object('interestId', i.id, 'forProfileId', $3::uuid,
                                 'aboutProfileId', CASE WHEN i.sender_profile_id = $3::uuid THEN i.recipient_profile_id ELSE i.sender_profile_id END)
         FROM matrimony.interests i,
              (SELECT owner_account_id AS account_id FROM matrimony.member_profiles
                WHERE agency_id = $1 AND id = $3 AND owner_account_id IS NOT NULL
               UNION
               SELECT assigned_agent_id FROM matrimony.member_profiles
                WHERE agency_id = $1 AND id = $3 AND assigned_agent_id IS NOT NULL) w
        WHERE i.agency_id = $1 AND i.id = $2 AND w.account_id <> $4::uuid`,
      [agencyId, interestId, profileId, actorId, `guardian-advice:${interestId}:${randomUUID()}`],
    );
  }
}
