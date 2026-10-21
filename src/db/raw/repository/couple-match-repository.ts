import type { Transaction } from '../../config/database.js';
import { profileQueries } from '../query/profile.js';

type Row = Record<string, unknown>;

export interface MatchProfile {
  id: string;
  fullName: string;
  memberCode: string;
  status: string;
  assignedAgentId: string | null;
}

/** The matched step: one record per matched connection, and the success story that may follow. */
export class CoupleMatchRepository {
  async interest(tx: Transaction, agencyId: string, interestId: string) {
    const result = await tx.query(
      `SELECT id, status, sender_profile_id, recipient_profile_id
         FROM matrimony.interests WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
      [agencyId, interestId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          status: row.status as string,
          aId: row.sender_profile_id as string,
          bId: row.recipient_profile_id as string,
        }
      : null;
  }

  async profile(
    tx: Transaction,
    agencyId: string,
    profileId: string,
  ): Promise<MatchProfile | null> {
    const result = await tx.query(
      `SELECT id, full_name, member_code, status, assigned_agent_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          fullName: row.full_name as string,
          memberCode: row.member_code as string,
          status: row.status as string,
          assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
        }
      : null;
  }

  async existing(tx: Transaction, agencyId: string, interestId: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM matrimony.couple_matches WHERE agency_id = $1 AND interest_id = $2 AND undone_at IS NULL`,
      [agencyId, interestId],
    );
    return result.rows.length > 0;
  }

  /** Both clients leave the search: they stop being published and their other waiting proposals end. */
  async matchProfile(tx: Transaction, agencyId: string, profileId: string): Promise<void> {
    await tx.query(profileQueries.updateStatus, [agencyId, profileId, 'matched']);
    await tx.query(profileQueries.withdrawOpenRequests, [agencyId, profileId, 'interest.matched']);
  }

  /** Sets what a client agreed to pay as the success fee. */
  async setSuccessFee(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    amount: number,
    by: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.client_agreements (agency_id, profile_id, stage, amount, set_by)
       VALUES ($1, $2, 'success', $3, $4)
       ON CONFLICT (agency_id, profile_id, stage)
       DO UPDATE SET amount = EXCLUDED.amount, set_by = EXCLUDED.set_by, updated_at = now()`,
      [agencyId, profileId, amount, by],
    );
  }

  async insertMatch(
    tx: Transaction,
    agencyId: string,
    m: { interestId: string; a: string; b: string; by: string; note: string | null },
  ): Promise<string> {
    const result = await tx.query(
      `INSERT INTO matrimony.couple_matches (agency_id, interest_id, profile_a, profile_b, matched_by, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [agencyId, m.interestId, m.a, m.b, m.by, m.note],
    );
    return (result.rows[0] as Row).id as string;
  }

  async insertStory(
    tx: Transaction,
    agencyId: string,
    s: {
      matchId: string;
      names: Record<string, string>;
      text: Record<string, string>;
      year: number | null;
      consentA: boolean;
      consentB: boolean;
      by: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.success_stories
         (agency_id, match_id, names, story, story_year, consent_a_at, consent_b_at, consent_by, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5,
               CASE WHEN $6::boolean THEN now() END, CASE WHEN $7::boolean THEN now() END,
               CASE WHEN $6::boolean OR $7::boolean THEN $8::uuid END, $8)`,
      [
        agencyId,
        s.matchId,
        JSON.stringify(s.names),
        Object.keys(s.text).length > 0 ? JSON.stringify(s.text) : null,
        s.year,
        s.consentA,
        s.consentB,
        s.by,
      ],
    );
  }

  /** The story of a match, with whether both clients agreed. Null when there is none. */
  async storyOfInterest(tx: Transaction, agencyId: string, interestId: string) {
    const result = await tx.query(
      `SELECT st.id, st.status, (st.consent_a_at IS NOT NULL AND st.consent_b_at IS NOT NULL) AS both_ok
         FROM matrimony.success_stories st
         JOIN matrimony.couple_matches m ON m.agency_id = st.agency_id AND m.id = st.match_id
        WHERE st.agency_id = $1 AND m.interest_id = $2 AND m.undone_at IS NULL`,
      [agencyId, interestId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          status: row.status as 'draft' | 'published' | 'hidden',
          consentBoth: row.both_ok === true,
        }
      : null;
  }

  async setStoryStatus(
    tx: Transaction,
    agencyId: string,
    storyId: string,
    status: 'published' | 'hidden',
  ): Promise<{ changed: boolean; consentBoth: boolean } | null> {
    const found = await tx.query(
      `SELECT (consent_a_at IS NOT NULL AND consent_b_at IS NOT NULL) AS both_ok
         FROM matrimony.success_stories WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
      [agencyId, storyId],
    );
    const row = found.rows[0] as Row | undefined;
    if (!row) return null;
    const consentBoth = row.both_ok === true;
    if (status === 'published' && !consentBoth) return { changed: false, consentBoth };
    await tx.query(
      `UPDATE matrimony.success_stories
          SET status = $3, updated_at = now(),
              published_at = CASE WHEN $3 = 'published' THEN coalesce(published_at, now()) ELSE published_at END
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, storyId, status],
    );
    return { changed: true, consentBoth };
  }

  /**
   * Removes a story's names and words for good (the row stays, empty and hidden, with who, when and why), and clears
   * the couple's consents so it can never be published again. 'missing' when there is no such story.
   */
  async removeStory(
    tx: Transaction,
    agencyId: string,
    storyId: string,
    by: string,
    reason: string,
  ): Promise<'removed' | 'missing' | 'already'> {
    const found = await tx.query(
      `SELECT removed_at IS NOT NULL AS removed FROM matrimony.success_stories
        WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
      [agencyId, storyId],
    );
    const row = found.rows[0] as Row | undefined;
    if (!row) return 'missing';
    if (row.removed === true) return 'already';
    await tx.query(
      `UPDATE matrimony.success_stories
          SET names = '{}'::jsonb, story = NULL, story_year = NULL, status = 'hidden',
              consent_a_at = NULL, consent_b_at = NULL, consent_by = NULL, published_at = NULL,
              removed_at = now(), removed_by = $3, removed_reason = $4, updated_at = now()
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, storyId, by, reason],
    );
    return 'removed';
  }

  /** The match standing for a connection, if there is one. */
  async standingMatch(tx: Transaction, agencyId: string, interestId: string) {
    const result = await tx.query(
      `SELECT id FROM matrimony.couple_matches
        WHERE agency_id = $1 AND interest_id = $2 AND undone_at IS NULL FOR UPDATE`,
      [agencyId, interestId],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? (row.id as string) : null;
  }

  /** Marks the match undone, with who did it and why. The record stays. */
  async undoMatch(
    tx: Transaction,
    agencyId: string,
    matchId: string,
    by: string,
    reason: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE matrimony.couple_matches SET undone_at = now(), undone_by = $3, undo_reason = $4
        WHERE agency_id = $1 AND id = $2 AND undone_at IS NULL`,
      [agencyId, matchId, by, reason],
    );
  }

  /** A client who was matched goes back to active; any other status (changed by hand since) is left alone. */
  async reopenProfile(tx: Transaction, agencyId: string, profileId: string): Promise<void> {
    await tx.query(
      `UPDATE matrimony.member_profiles SET status = 'active'
        WHERE agency_id = $1 AND id = $2 AND status = 'matched'`,
      [agencyId, profileId],
    );
  }

  /** The success story of a match is hidden, whatever it was (a published one stops showing at once). */
  async hideStoryOfMatch(tx: Transaction, agencyId: string, matchId: string): Promise<void> {
    await tx.query(
      `UPDATE matrimony.success_stories SET status = 'hidden', updated_at = now()
        WHERE agency_id = $1 AND match_id = $2 AND status <> 'hidden'`,
      [agencyId, matchId],
    );
  }
}
