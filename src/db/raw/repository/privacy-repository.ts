import type { ConsentEntry, DataExport, ErasureState } from '../../../bo/privacy.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

/** The columns that are internal bookkeeping, not the person's data. Taken off whole rows so a new column is exported by default. */
const PROFILE_HIDDEN = [
  'agency_id',
  'owner_account_id',
  'created_by_account_id',
  'assigned_agent_id',
  'status_before_deletion',
  'version',
  'verified_by',
  'matching_override_at',
  'matching_override_by',
  'matching_override_reason',
];

const without = (alias: string, hidden: string[]) =>
  `to_jsonb(${alias}) ${hidden.map((column) => `- '${column}'`).join(' ')}`;

/**
 * Reads for the privacy tools: the consent log, the copy of a person's data, and who a profile belongs to.
 * Erasure itself is the database functions of migration 052 (see AccountDeletionRepository).
 */
export class PrivacyRepository {
  /** The profile a member owns (the first, if more than one), or the client's profile; with whether it has a login. */
  async subject(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT id, member_code, full_name, service_mode, owner_account_id, assigned_agent_id,
              erased_at IS NOT NULL AS erased
         FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          memberCode: row.member_code as string,
          name: row.full_name as string,
          assisted: row.service_mode === 'assisted' && row.owner_account_id === null,
          ownerAccountId: (row.owner_account_id as string | null) ?? null,
          assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
          erased: row.erased === true,
        }
      : null;
  }

  /** Where the erasure of a client stands. `erasesOn` is when a scheduled one happens. */
  async erasure(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    graceDays: number,
  ): Promise<ErasureState> {
    const result = await tx.query(
      `SELECT p.erasure_scheduled_at, p.erasure_reason, p.erased_at, a.display_name AS by_name
         FROM matrimony.member_profiles p
         LEFT JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.erasure_requested_by
        WHERE p.agency_id = $1 AND p.id = $2`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    const scheduled = (row?.erasure_scheduled_at as Date | null) ?? null;
    const erased = (row?.erased_at as Date | null) ?? null;
    return {
      status: erased ? 'erased' : scheduled ? 'scheduled' : 'none',
      erasesOn:
        scheduled && !erased
          ? new Date(scheduled.getTime() + graceDays * 24 * 3600 * 1000).toISOString()
          : null,
      reason: (row?.erasure_reason as string | null) ?? null,
      requestedBy: (row?.by_name as string | null) ?? null,
      erasedAt: erased ? erased.toISOString() : null,
    };
  }

  /** The profile a member owns. */
  async profileOf(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT id FROM matrimony.member_profiles
        WHERE agency_id = $1 AND owner_account_id = $2 ORDER BY created_at LIMIT 1`,
      [agencyId, accountId],
    );
    return (result.rows[0] as { id: string } | undefined)?.id ?? null;
  }

  async consents(
    tx: Transaction,
    agencyId: string,
    accountId: string | null,
    profileId: string | null,
  ): Promise<ConsentEntry[]> {
    const result = await tx.query(
      `SELECT purpose, document_version, action, created_at
         FROM matrimony.consent_events
        WHERE agency_id = $1 AND (account_id = $2 OR profile_id = $3)
        ORDER BY created_at, id`,
      [agencyId, accountId, profileId],
    );
    return (result.rows as Row[]).map((row) => ({
      purpose: row.purpose as ConsentEntry['purpose'],
      documentVersion: row.document_version as string,
      action: row.action as ConsentEntry['action'],
      createdAt: (row.created_at as Date).toISOString(),
    }));
  }

  /** Everything the agency holds about one profile, for the export. */
  async collect(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    accountId: string | null,
  ): Promise<Omit<DataExport, 'generatedAt' | 'subject' | 'notes' | 'consents'>> {
    const one = async (sql: string, args: unknown[]) =>
      ((await tx.query(sql, args)).rows[0] as { v: Row | null } | undefined)?.v ?? null;
    const many = async (sql: string, args: unknown[]) => (await tx.query(sql, args)).rows as Row[];
    const A = [agencyId, profileId];

    const account = accountId
      ? await one(
          `SELECT jsonb_build_object(
                    'displayName', a.display_name, 'email', a.email, 'phone', a.phone_e164,
                    'language', a.locale, 'joinedAt', a.created_at,
                    'hasPassword', EXISTS (SELECT 1 FROM matrimony.account_credentials c
                                            WHERE c.agency_id = a.agency_id AND c.account_id = a.id),
                    'googleConnected', EXISTS (SELECT 1 FROM matrimony.account_identities i
                                                WHERE i.agency_id = a.agency_id AND i.account_id = a.id
                                                  AND i.provider = 'google')) AS v
             FROM matrimony.accounts a WHERE a.agency_id = $1 AND a.id = $2`,
          [agencyId, accountId],
        )
      : null;
    const profile = await one(
      `SELECT ${without('p', PROFILE_HIDDEN)} AS v FROM matrimony.member_profiles p
        WHERE p.agency_id = $1 AND p.id = $2`,
      A,
    );
    const contact = await one(
      `SELECT ${without('c', ['agency_id'])} AS v FROM matrimony.profile_contacts c
        WHERE c.agency_id = $1 AND c.profile_id = $2`,
      A,
    );
    const partnerPreferences = await one(
      `SELECT ${without('x', ['agency_id'])} AS v FROM matrimony.partner_preferences x
        WHERE x.agency_id = $1 AND x.profile_id = $2`,
      A,
    );
    const photos = await many(
      `SELECT status, is_primary AS "isMain", byte_size AS "bytes", created_at AS "addedAt"
         FROM matrimony.profile_photos WHERE agency_id = $1 AND profile_id = $2
        ORDER BY created_at`,
      A,
    );
    const cv = await many(
      `SELECT file_name AS "fileName", status, byte_size AS "bytes", created_at AS "addedAt"
         FROM matrimony.profile_cvs WHERE agency_id = $1 AND profile_id = $2 ORDER BY created_at`,
      A,
    );
    const verification = await many(
      `SELECT doc_type AS "document", status, checks, submitted_at AS "sentAt", decided_at AS "decidedAt",
              decision_note AS "reason", file_removed_at AS "fileDeletedAt"
         FROM matrimony.profile_verifications WHERE agency_id = $1 AND profile_id = $2
        ORDER BY submitted_at`,
      A,
    );
    const guardians = await many(
      `SELECT display_name AS name, email, status, consent_basis AS "consentBasis",
              consented_at AS "consentedAt", created_at AS "invitedAt"
         FROM matrimony.profile_guardians WHERE agency_id = $1 AND profile_id = $2
        ORDER BY created_at`,
      A,
    );
    // The other side of a proposal is named by member code only.
    const proposals = await many(
      `SELECT CASE WHEN i.sender_profile_id = $2 THEN 'sent' ELSE 'received' END AS direction,
              o.member_code AS "otherMemberCode", i.status, i.created_at AS "at",
              i.responded_at AS "answeredAt",
              CASE WHEN i.recipient_profile_id = $2 THEN i.decline_reason END AS "myDeclineReason"
         FROM matrimony.interests i
         JOIN matrimony.member_profiles o ON o.agency_id = i.agency_id
          AND o.id = CASE WHEN i.sender_profile_id = $2 THEN i.recipient_profile_id ELSE i.sender_profile_id END
        WHERE i.agency_id = $1 AND (i.sender_profile_id = $2 OR i.recipient_profile_id = $2)
        ORDER BY i.created_at`,
      A,
    );
    const meetings = await many(
      `SELECT o.member_code AS "withMemberCode", m.kind, m.status, m.scheduled_at AS "at", m.place,
              f.verdict AS "myVerdict", f.note AS "myNote", f.reason AS "myReason"
         FROM matrimony.meetings m
         JOIN matrimony.interests i ON i.agency_id = m.agency_id AND i.id = m.interest_id
         JOIN matrimony.member_profiles o ON o.agency_id = i.agency_id
          AND o.id = CASE WHEN i.sender_profile_id = $2 THEN i.recipient_profile_id ELSE i.sender_profile_id END
         LEFT JOIN matrimony.meeting_feedback f ON f.agency_id = m.agency_id AND f.meeting_id = m.id
          AND f.profile_id = $2
        WHERE m.agency_id = $1 AND (i.sender_profile_id = $2 OR i.recipient_profile_id = $2)
        ORDER BY m.scheduled_at`,
      A,
    );
    const agreedAmounts = await many(
      `SELECT stage, amount, updated_at AS "setAt" FROM matrimony.client_agreements
        WHERE agency_id = $1 AND profile_id = $2 ORDER BY stage`,
      A,
    );
    const payments = await many(
      `SELECT stage, amount, paid_on AS "paidOn", method, reference, note, created_at AS "recordedAt",
              voided_at AS "cancelledAt", void_reason AS "cancelReason"
         FROM matrimony.client_payments WHERE agency_id = $1 AND profile_id = $2 ORDER BY paid_on, created_at`,
      A,
    );
    const serviceTerms = await many(
      `SELECT version, coverage, introductions, refund_rule AS "refundRule", created_at AS "writtenAt",
              acknowledged_at AS "confirmedAt", acknowledged_how AS "confirmedHow"
         FROM matrimony.client_service_terms WHERE agency_id = $1 AND profile_id = $2 ORDER BY version`,
      A,
    );
    const concerns = await many(
      `SELECT about_kind AS about, category, message, status, outcome_note AS outcome, created_at AS "at"
         FROM matrimony.concern_reports
        WHERE agency_id = $1 AND (for_profile_id = $2 OR ($3::uuid IS NOT NULL AND reporter_account_id = $3))
        ORDER BY created_at`,
      [agencyId, profileId, accountId],
    );
    // Only what the person wrote themselves.
    const messages = await many(
      `SELECT CASE WHEN c.profile_a = $2 THEN pb.member_code ELSE pa.member_code END AS "withMemberCode",
              m.body, m.created_at AS "at"
         FROM matrimony.chat_messages m
         JOIN matrimony.chat_conversations c ON c.agency_id = m.agency_id AND c.id = m.conversation_id
         JOIN matrimony.member_profiles pa ON pa.agency_id = c.agency_id AND pa.id = c.profile_a
         JOIN matrimony.member_profiles pb ON pb.agency_id = c.agency_id AND pb.id = c.profile_b
        WHERE m.agency_id = $1 AND m.sender_profile_id = $2 ORDER BY m.created_at`,
      A,
    );
    return {
      account,
      profile,
      contact,
      partnerPreferences,
      photos,
      cv,
      verification,
      guardians,
      proposals,
      meetings,
      agreedAmounts,
      payments,
      serviceTerms,
      concerns,
      messages,
    };
  }
}
