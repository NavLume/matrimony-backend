import type {
  AgentIntroductions,
  ConnectionHistory,
  HistoryActor,
  HistoryEvent,
  HistoryKind,
} from '../../../bo/introduction.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

const iso = (value: unknown) => (value ? (value as Date).toISOString() : '');
const actorOf = (name: unknown, role: unknown): HistoryActor | null =>
  name ? { name: name as string, role: role as HistoryActor['role'] } : null;

/** Reads the introduction ledger from what the platform already stores (see bo/introduction.ts). */
export class IntroductionRepository {
  /** The two sides of a connection, and who looks after each, so access can be decided. */
  async parties(tx: Transaction, agencyId: string, connectionId: string) {
    const result = await tx.query(
      `SELECT i.sender_profile_id, i.recipient_profile_id,
              s.assigned_agent_id AS sender_agent, r.assigned_agent_id AS recipient_agent
         FROM matrimony.interests i
         JOIN matrimony.member_profiles s ON s.agency_id = i.agency_id AND s.id = i.sender_profile_id
         JOIN matrimony.member_profiles r ON r.agency_id = i.agency_id AND r.id = i.recipient_profile_id
        WHERE i.agency_id = $1 AND i.id = $2`,
      [agencyId, connectionId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          senderId: row.sender_profile_id as string,
          recipientId: row.recipient_profile_id as string,
          senderAgent: (row.sender_agent as string | null) ?? null,
          recipientAgent: (row.recipient_agent as string | null) ?? null,
        }
      : null;
  }

  /** Everything that happened to one proposal, oldest first. */
  async history(
    tx: Transaction,
    agencyId: string,
    connectionId: string,
  ): Promise<ConnectionHistory> {
    const A = [agencyId, connectionId];
    const head = (
      await tx.query(
        `SELECT i.sender_profile_id AS sid, i.recipient_profile_id AS rid, i.created_at, i.status,
                i.reviewed_at, i.responded_at,
                s.member_code AS s_code, s.full_name AS s_name, sa.display_name AS s_agent,
                r.member_code AS r_code, r.full_name AS r_name, ra.display_name AS r_agent,
                ia.display_name AS init_name, ia.role AS init_role,
                rv.display_name AS rev_name, rv.role AS rev_role,
                rs.display_name AS resp_name, rs.role AS resp_role
           FROM matrimony.interests i
           JOIN matrimony.member_profiles s ON s.agency_id = i.agency_id AND s.id = i.sender_profile_id
           JOIN matrimony.member_profiles r ON r.agency_id = i.agency_id AND r.id = i.recipient_profile_id
           LEFT JOIN matrimony.accounts sa ON sa.agency_id = s.agency_id AND sa.id = s.assigned_agent_id
           LEFT JOIN matrimony.accounts ra ON ra.agency_id = r.agency_id AND ra.id = r.assigned_agent_id
           LEFT JOIN matrimony.accounts ia ON ia.agency_id = i.agency_id AND ia.id = i.initiated_by_account_id
           LEFT JOIN matrimony.accounts rv ON rv.agency_id = i.agency_id AND rv.id = i.reviewed_by_account_id
           LEFT JOIN matrimony.accounts rs ON rs.agency_id = i.agency_id AND rs.id = i.responded_by_account_id
          WHERE i.agency_id = $1 AND i.id = $2`,
        A,
      )
    ).rows[0] as Row;

    const events: HistoryEvent[] = [];
    const add = (
      kind: HistoryKind,
      at: unknown,
      by: HistoryActor | null,
      aboutMemberCode: string | null,
      detail: string | null = null,
    ) => {
      if (at) events.push({ kind, at: iso(at), by, aboutMemberCode, detail });
    };

    // The agent who released the person asked about to the client who asked, before they asked.
    const suggestion = (
      await tx.query(
        `SELECT c.decided_at, a.display_name, a.role
           FROM matrimony.client_candidates c
           LEFT JOIN matrimony.accounts a ON a.agency_id = c.agency_id AND a.id = c.decided_by
          WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.candidate_profile_id = $3
            AND c.state IN ('released', 'lapsed') AND c.decided_at IS NOT NULL AND c.decided_at <= $4`,
        [agencyId, head.sid, head.rid, head.created_at],
      )
    ).rows[0] as Row | undefined;
    if (suggestion)
      add(
        'suggested',
        suggestion.decided_at,
        actorOf(suggestion.display_name, suggestion.role),
        head.s_code as string,
      );

    add(
      'requested',
      head.created_at,
      actorOf(head.init_name, head.init_role),
      head.s_code as string,
    );
    if (head.reviewed_at) {
      // A rejected request ends as declined with nobody having answered it.
      const rejected = head.status === 'declined' && !head.resp_name;
      add(
        rejected ? 'rejected' : 'approved',
        head.reviewed_at,
        actorOf(head.rev_name, head.rev_role),
        null,
      );
    }
    if (head.responded_at && (head.status === 'accepted' || head.status === 'declined'))
      add(
        head.status === 'accepted' ? 'accepted' : 'declined',
        head.responded_at,
        actorOf(head.resp_name, head.resp_role),
        head.r_code as string,
      );

    const meetings = await tx.query(
      `SELECT m.created_at, m.kind, m.status, a.display_name, a.role
         FROM matrimony.meetings m
         LEFT JOIN matrimony.accounts a ON a.agency_id = m.agency_id AND a.id = m.created_by
        WHERE m.agency_id = $1 AND m.interest_id = $2`,
      A,
    );
    for (const row of meetings.rows as Row[])
      add(
        'meeting',
        row.created_at,
        actorOf(row.display_name, row.role),
        null,
        `${row.kind}:${row.status}`,
      );

    const matches = await tx.query(
      `SELECT cm.matched_at, cm.undone_at, mb.display_name AS m_name, mb.role AS m_role,
              ub.display_name AS u_name, ub.role AS u_role
         FROM matrimony.couple_matches cm
         LEFT JOIN matrimony.accounts mb ON mb.agency_id = cm.agency_id AND mb.id = cm.matched_by
         LEFT JOIN matrimony.accounts ub ON ub.agency_id = cm.agency_id AND ub.id = cm.undone_by
        WHERE cm.agency_id = $1 AND cm.interest_id = $2`,
      A,
    );
    for (const row of matches.rows as Row[]) {
      add('matched', row.matched_at, actorOf(row.m_name, row.m_role), null);
      add('unmatched', row.undone_at, actorOf(row.u_name, row.u_role), null);
    }

    // A client handed to another agent while this proposal was alive, on either side.
    const first = events.reduce(
      (min, e) => (e.at < min ? e.at : min),
      events[0]?.at ?? iso(head.created_at),
    );
    const handovers = await tx.query(
      `SELECT g.created_at, p.member_code, a.display_name AS by_name, a.role AS by_role, t.display_name AS to_name
         FROM matrimony.client_assignments g
         JOIN matrimony.member_profiles p ON p.agency_id = g.agency_id AND p.id = g.profile_id
         LEFT JOIN matrimony.accounts a ON a.agency_id = g.agency_id AND a.id = g.changed_by_account_id
         LEFT JOIN matrimony.accounts t ON t.agency_id = g.agency_id AND t.id = g.to_agent_id
        WHERE g.agency_id = $1 AND g.profile_id IN ($2, $3) AND g.reason <> 'earlier' AND g.created_at >= $4`,
      [agencyId, head.sid, head.rid, first],
    );
    for (const row of handovers.rows as Row[])
      add(
        'handed_over',
        row.created_at,
        actorOf(row.by_name, row.by_role),
        row.member_code as string,
        (row.to_name as string | null) ?? null,
      );

    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return {
      connectionId,
      sides: [
        {
          memberCode: head.s_code as string,
          fullName: head.s_name as string,
          agent: (head.s_agent as string | null) ?? null,
        },
        {
          memberCode: head.r_code as string,
          fullName: head.r_name as string,
          agent: (head.r_agent as string | null) ?? null,
        },
      ],
      events,
    };
  }

  /** Each staff member's introductions in a range of dates (the whole history when none is given). */
  async byAgent(
    tx: Transaction,
    agencyId: string,
    from: string | null,
    to: string | null,
  ): Promise<AgentIntroductions[]> {
    const range = (column: string) =>
      `($2::date IS NULL OR ${column} >= $2::date) AND ($3::date IS NULL OR ${column} < $3::date + 1)`;
    const result = await tx.query(
      `WITH introduced AS (
         SELECT c.decided_by AS agent,
                count(*)::int AS suggested,
                count(*) FILTER (WHERE i.id IS NOT NULL)::int AS asked,
                count(*) FILTER (WHERE i.status = 'accepted')::int AS accepted,
                count(*) FILTER (WHERE m.id IS NOT NULL)::int AS matched
           FROM matrimony.client_candidates c
           LEFT JOIN LATERAL (
                  SELECT x.id, x.status FROM matrimony.interests x
                   WHERE x.agency_id = c.agency_id AND x.sender_profile_id = c.client_profile_id
                     AND x.recipient_profile_id = c.candidate_profile_id AND x.created_at >= c.decided_at
                   ORDER BY x.created_at LIMIT 1) i ON true
           LEFT JOIN matrimony.couple_matches m ON m.agency_id = c.agency_id AND m.interest_id = i.id AND m.undone_at IS NULL
          WHERE c.agency_id = $1 AND c.state IN ('released', 'lapsed') AND c.decided_by IS NOT NULL
            AND ${range('c.decided_at')}
          GROUP BY c.decided_by),
       reviewed AS (
         SELECT i.reviewed_by_account_id AS agent,
                count(*) FILTER (WHERE NOT (i.status = 'declined' AND i.responded_by_account_id IS NULL))::int AS approved,
                count(*) FILTER (WHERE i.status = 'declined' AND i.responded_by_account_id IS NULL)::int AS rejected
           FROM matrimony.interests i
          WHERE i.agency_id = $1 AND i.reviewed_by_account_id IS NOT NULL AND ${range('i.reviewed_at')}
          GROUP BY i.reviewed_by_account_id),
       arranged AS (
         SELECT created_by AS agent, count(*)::int AS n FROM matrimony.meetings
          WHERE agency_id = $1 AND ${range('created_at')} GROUP BY created_by),
       recorded AS (
         SELECT matched_by AS agent, count(*)::int AS n FROM matrimony.couple_matches
          WHERE agency_id = $1 AND undone_at IS NULL AND ${range('matched_at')} GROUP BY matched_by)
       SELECT a.id, a.display_name, a.role,
              coalesce(n.suggested, 0) AS suggested, coalesce(n.asked, 0) AS asked,
              coalesce(n.accepted, 0) AS accepted, coalesce(n.matched, 0) AS matched,
              coalesce(rv.approved, 0) AS approved, coalesce(rv.rejected, 0) AS rejected,
              coalesce(ar.n, 0) AS meetings, coalesce(rc.n, 0) AS matches
         FROM matrimony.accounts a
         LEFT JOIN introduced n ON n.agent = a.id
         LEFT JOIN reviewed rv ON rv.agent = a.id
         LEFT JOIN arranged ar ON ar.agent = a.id
         LEFT JOIN recorded rc ON rc.agent = a.id
        WHERE a.agency_id = $1 AND a.role IN ('agent', 'admin') AND a.erased_at IS NULL
        ORDER BY coalesce(n.suggested, 0) DESC, a.display_name`,
      [agencyId, from, to],
    );
    return (result.rows as Row[]).map((row) => ({
      agentId: row.id as string,
      name: row.display_name as string,
      role: row.role as 'admin' | 'agent',
      suggested: row.suggested as number,
      ledToRequest: row.asked as number,
      ledToAccepted: row.accepted as number,
      ledToMatch: row.matched as number,
      approved: row.approved as number,
      rejected: row.rejected as number,
      meetingsArranged: row.meetings as number,
      matchesRecorded: row.matches as number,
    }));
  }
}
