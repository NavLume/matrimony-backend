import type { DeclinePatterns, DeclinePatternItem } from '../../../bo/decline.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

/** What clients said no to, counted by reason. */
export class DeclineRepository {
  /** The client the patterns are for: who looks after them, and whether the profile exists in this agency. */
  async clientOf(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      'SELECT assigned_agent_id FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2',
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? { assignedAgentId: (row.assigned_agent_id as string | null) ?? null } : null;
  }

  /**
   * The no's of one client, or of the whole agency when no client is given. A proposal counts when the person
   * asked declined it themselves (a request the agent rejected during review was never put to them). A meeting
   * counts when the verdict recorded for the client was "not interested".
   */
  async patterns(
    tx: Transaction,
    agencyId: string,
    profileId: string | null,
  ): Promise<DeclinePatterns> {
    const result = await tx.query(
      `WITH d AS (
         SELECT coalesce(i.decline_reason, 'not_given') AS reason, 'proposal' AS source
           FROM matrimony.interests i
          WHERE i.agency_id = $1 AND i.status = 'declined' AND i.responded_by_account_id IS NOT NULL
            AND ($2::uuid IS NULL OR i.recipient_profile_id = $2::uuid)
         UNION ALL
         SELECT coalesce(f.reason, 'not_given'), 'meeting'
           FROM matrimony.meeting_feedback f
          WHERE f.agency_id = $1 AND f.verdict = 'not_interested'
            AND ($2::uuid IS NULL OR f.profile_id = $2::uuid)
       )
       SELECT reason,
              count(*) FILTER (WHERE source = 'proposal')::int AS proposals,
              count(*) FILTER (WHERE source = 'meeting')::int AS meetings
         FROM d GROUP BY reason ORDER BY count(*) DESC, reason`,
      [agencyId, profileId],
    );
    const items = (result.rows as Row[]).map(
      (row) =>
        ({
          reason: row.reason as DeclinePatternItem['reason'],
          proposals: row.proposals as number,
          meetings: row.meetings as number,
        }) satisfies DeclinePatternItem,
    );
    return { total: items.reduce((sum, item) => sum + item.proposals + item.meetings, 0), items };
  }
}
