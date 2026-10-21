import type {
  ToldBy,
  ConcernAbout,
  ConcernCategory,
  ConcernInput,
  ConcernRow,
  MyConcern,
} from '../../../bo/concern.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

const iso = (value: unknown) => (value ? (value as Date).toISOString() : null);

const mine = (row: Row): MyConcern => ({
  id: row.id as string,
  about: row.about_kind as ConcernAbout,
  aboutCode: (row.about_code as string | null) ?? null,
  category: row.category as ConcernCategory,
  message: row.message as string,
  sharedWithAgent: row.share_with_agent === true,
  status: row.status as 'open' | 'resolved',
  createdAt: iso(row.created_at)!,
  resolvedAt: iso(row.resolved_at),
  outcomeNote: (row.outcome_note as string | null) ?? null,
});

const COLUMNS = `c.id, c.about_kind, c.category, c.message, c.share_with_agent, c.status, c.created_at, c.resolved_at, c.outcome_note,
       ap.member_code AS about_code`;

/** Private concerns. A row is never changed except to record its outcome, once, and never deleted. */
export class ConcernRepository {
  /** Whether a profile of this agency exists and is not the reporter's own. */
  async reportable(tx: Transaction, agencyId: string, profileId: string, accountId: string) {
    const result = await tx.query(
      `SELECT 1 FROM matrimony.member_profiles
        WHERE agency_id = $1 AND id = $2 AND owner_account_id IS DISTINCT FROM $3::uuid`,
      [agencyId, profileId, accountId],
    );
    return result.rows.length === 1;
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    id: string,
    reporterId: string,
    input: ConcernInput,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.concern_reports
         (agency_id, id, reporter_account_id, about_kind, about_profile_id, category, message, share_with_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        agencyId,
        id,
        reporterId,
        input.about,
        input.profileId ?? null,
        input.category,
        input.message,
        input.shareWithMyAgent,
      ],
    );
  }

  /** A profile by its member code, or null. */
  async profileByCode(tx: Transaction, agencyId: string, code: string): Promise<string | null> {
    const result = await tx.query(
      `SELECT id FROM matrimony.member_profiles WHERE agency_id = $1 AND upper(member_code) = upper($2)`,
      [agencyId, code],
    );
    return ((result.rows[0] as Row | undefined)?.id as string | undefined) ?? null;
  }

  /** The client a concern is recorded for: only one with no login of their own can be. */
  async clientForRecording(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT id, service_mode, assigned_agent_id, owner_account_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          assisted: row.service_mode === 'assisted' && row.owner_account_id === null,
          assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
        }
      : null;
  }

  /** Records a concern for a client with no login. */
  async insertForClient(
    tx: Transaction,
    agencyId: string,
    id: string,
    clientId: string,
    recordedBy: string,
    toldBy: ToldBy,
    input: {
      about: ConcernAbout;
      aboutProfileId: string | null;
      category: ConcernCategory;
      message: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.concern_reports
         (agency_id, id, reporter_account_id, for_profile_id, recorded_by, told_by,
          about_kind, about_profile_id, category, message)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)`,
      [
        agencyId,
        id,
        clientId,
        recordedBy,
        toldBy,
        input.about,
        input.aboutProfileId,
        input.category,
        input.message,
      ],
    );
  }

  /** The reporter's own concerns, newest first. */
  async mine(tx: Transaction, agencyId: string, accountId: string): Promise<MyConcern[]> {
    const result = await tx.query(
      `SELECT ${COLUMNS}
         FROM matrimony.concern_reports c
         LEFT JOIN matrimony.member_profiles ap ON ap.agency_id = c.agency_id AND ap.id = c.about_profile_id
        WHERE c.agency_id = $1 AND c.reporter_account_id = $2
        ORDER BY c.created_at DESC LIMIT 100`,
      [agencyId, accountId],
    );
    return (result.rows as Row[]).map(mine);
  }

  /**
   * What staff see: the concerns in one state. An admin sees all. An agent sees those about a profile of a client they
   * look after (without who reported them) and those the reporter shared with their own agent (with who reported).
   */
  async list(
    tx: Transaction,
    agencyId: string,
    status: 'open' | 'resolved',
    agentId: string | null,
  ): Promise<ConcernRow[]> {
    const result = await tx.query(
      `SELECT ${COLUMNS}, rep.display_name AS reporter_name, rp.member_code AS reporter_code,
              rp.assigned_agent_id AS reporter_agent,
              fp.id AS for_id, fp.member_code AS for_code, fp.full_name AS for_name,
              rb.display_name AS recorded_by_name, c.recorded_by, c.told_by,
              ap.id AS about_id, ap.full_name AS about_name, res.display_name AS resolved_by_name
         FROM matrimony.concern_reports c
         LEFT JOIN matrimony.accounts rep ON rep.agency_id = c.agency_id AND rep.id = c.reporter_account_id
         LEFT JOIN matrimony.member_profiles fp ON fp.agency_id = c.agency_id AND fp.id = c.for_profile_id
         LEFT JOIN matrimony.accounts rb ON rb.agency_id = c.agency_id AND rb.id = c.recorded_by
         LEFT JOIN matrimony.member_profiles rp ON rp.agency_id = c.agency_id AND rp.owner_account_id = c.reporter_account_id
         LEFT JOIN matrimony.member_profiles ap ON ap.agency_id = c.agency_id AND ap.id = c.about_profile_id
         LEFT JOIN matrimony.accounts res ON res.agency_id = c.agency_id AND res.id = c.resolved_by
        WHERE c.agency_id = $1 AND c.status = $2
          AND ($3::uuid IS NULL
               OR (c.about_kind = 'profile' AND ap.assigned_agent_id = $3)
               OR (c.share_with_agent AND rp.assigned_agent_id = $3)
               OR c.recorded_by = $3)
        ORDER BY CASE WHEN c.status = 'open' THEN c.created_at END ASC, c.resolved_at DESC
        LIMIT 200`,
      [agencyId, status, agentId],
    );
    return (result.rows as Row[]).map((row) => ({
      ...mine(row),
      // Who reported it: shown to an admin, to the reporter's own agent when it was shared, and to the staff member who
      // recorded it for a client. A concern recorded for a client names that client.
      reporter:
        agentId === null ||
        (row.share_with_agent === true && row.reporter_agent === agentId) ||
        row.recorded_by === agentId
          ? {
              name: (row.reporter_name ?? row.for_name) as string,
              memberCode: ((row.reporter_code ?? row.for_code) as string | null) ?? null,
            }
          : null,
      recorded: row.for_id
        ? {
            forClient: {
              id: row.for_id as string,
              memberCode: row.for_code as string,
              fullName: row.for_name as string,
            },
            by: row.recorded_by_name as string,
            toldBy: row.told_by as ToldBy,
          }
        : null,
      aboutProfile: row.about_id
        ? {
            id: row.about_id as string,
            memberCode: row.about_code as string,
            fullName: row.about_name as string,
          }
        : null,
      resolvedBy: (row.resolved_by_name as string | null) ?? null,
    }));
  }

  /**
   * Records the outcome, once. `found` is false when it was not open (or, for an agent, not one they may read);
   * `reporter` is the reporter's account, null for a concern recorded for a client with no login.
   */
  async resolve(
    tx: Transaction,
    agencyId: string,
    id: string,
    by: string,
    note: string,
    agentId: string | null,
  ): Promise<{ found: boolean; reporter: string | null }> {
    const result = await tx.query(
      `UPDATE matrimony.concern_reports
          SET status = 'resolved', resolved_by = $3, resolved_at = now(), outcome_note = $4
        WHERE agency_id = $1 AND id = $2 AND status = 'open'
          AND ($5::uuid IS NULL
               OR (about_kind = 'profile' AND EXISTS (
                    SELECT 1 FROM matrimony.member_profiles p
                     WHERE p.agency_id = $1 AND p.id = about_profile_id AND p.assigned_agent_id = $5))
               OR (share_with_agent AND EXISTS (
                    SELECT 1 FROM matrimony.member_profiles r
                     WHERE r.agency_id = $1 AND r.owner_account_id = reporter_account_id
                       AND r.assigned_agent_id = $5))
               OR recorded_by = $5)
        RETURNING reporter_account_id`,
      [agencyId, id, by, note, agentId],
    );
    const row = result.rows[0] as Row | undefined;
    return {
      found: row !== undefined,
      reporter: (row?.reporter_account_id as string | null) ?? null,
    };
  }

  /**
   * Tells the staff who may read a concern that it came in: every active admin, for a concern about a profile the
   * agent who looks after that client, and the reporter's own agent when the reporter shared it. Never the reporter.
   */
  async tellStaff(tx: Transaction, agencyId: string, concernId: string, reporterId: string) {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       SELECT $1, r.id, 'concern-reported:' || $2::text || ':' || r.id::text, 'concern.reported',
              jsonb_build_object('concernId', $2::uuid)
         FROM (
           SELECT a.id FROM matrimony.accounts a
            WHERE a.agency_id = $1 AND a.role = 'admin' AND a.status = 'active'
           UNION
           SELECT p.assigned_agent_id
             FROM matrimony.concern_reports c
             JOIN matrimony.member_profiles p ON p.agency_id = c.agency_id AND p.id = c.about_profile_id
             JOIN matrimony.accounts g ON g.agency_id = p.agency_id AND g.id = p.assigned_agent_id AND g.status = 'active'
            WHERE c.agency_id = $1 AND c.id = $2 AND c.about_kind = 'profile'
              AND p.assigned_agent_id IS NOT NULL
           UNION
           SELECT rp.assigned_agent_id
             FROM matrimony.concern_reports c
             JOIN matrimony.member_profiles rp ON rp.agency_id = c.agency_id AND rp.owner_account_id = c.reporter_account_id
             JOIN matrimony.accounts g ON g.agency_id = rp.agency_id AND g.id = rp.assigned_agent_id AND g.status = 'active'
            WHERE c.agency_id = $1 AND c.id = $2 AND c.share_with_agent
              AND rp.assigned_agent_id IS NOT NULL
         ) r(id)
        WHERE r.id <> $3::uuid`,
      [agencyId, concernId, reporterId],
    );
  }

  /** Tells the reporter their concern was handled. */
  async tellReporter(tx: Transaction, agencyId: string, concernId: string, reporterId: string) {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       VALUES ($1, $3, 'concern-resolved:' || $2::text, 'concern.resolved', jsonb_build_object('concernId', $2::uuid))
       ON CONFLICT (agency_id, recipient_account_id, event_key) DO NOTHING`,
      [agencyId, concernId, reporterId],
    );
  }
}
