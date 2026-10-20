import type { ActivityItem } from '../../../bo/activity.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

const POSITION = `to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Reads the agency's event log, newest first. Never writes. */
export class ActivityRepository {
  async list(
    tx: Transaction,
    agencyId: string,
    filter: {
      prefixes: readonly string[];
      text: string | null;
      from: string | null;
      to: string | null;
    },
    page: { limit: number; after: { createdAt: string; id: string } | null },
  ): Promise<(ActivityItem & { position: string })[]> {
    const result = await tx.query(
      `WITH e AS (
         SELECT o.id, o.created_at, ${POSITION} AS position, o.event->>'type' AS type,
                NULLIF(o.event->>'actorId', '')::uuid AS actor_id,
                NULLIF(o.event->>'subjectId', '')::uuid AS subject_id,
                o.event->>'occurredAt' AS occurred_at
           FROM matrimony.event_outbox o
          WHERE o.agency_id = $1
            AND split_part(o.event->>'type', '.', 1) = ANY($2::text[])
            AND ($3::date IS NULL OR (o.created_at AT TIME ZONE 'Asia/Dhaka')::date >= $3::date)
            AND ($4::date IS NULL OR (o.created_at AT TIME ZONE 'Asia/Dhaka')::date <= $4::date)
            AND ($5::timestamptz IS NULL OR (o.created_at, o.id) < ($5::timestamptz, $6::uuid))
       )
       SELECT e.id, e.type, e.position, e.occurred_at, e.created_at, e.actor_id,
              a.display_name AS actor_name, a.role AS actor_role,
              coalesce(
                sp.full_name || ' (' || sp.member_code || ')',
                sa.display_name,
                (SELECT s.full_name || ' · ' || r.full_name FROM matrimony.interests i
                   JOIN matrimony.member_profiles s ON s.agency_id = i.agency_id AND s.id = i.sender_profile_id
                   JOIN matrimony.member_profiles r ON r.agency_id = i.agency_id AND r.id = i.recipient_profile_id
                  WHERE i.agency_id = $1 AND i.id = e.subject_id),
                (SELECT p.full_name || ' (' || p.member_code || ')' FROM matrimony.client_payments c
                   JOIN matrimony.member_profiles p ON p.agency_id = c.agency_id AND p.id = c.profile_id
                  WHERE c.agency_id = $1 AND c.id = e.subject_id),
                (SELECT s.full_name || ' · ' || r.full_name FROM matrimony.meetings m
                   JOIN matrimony.interests i ON i.agency_id = m.agency_id AND i.id = m.interest_id
                   JOIN matrimony.member_profiles s ON s.agency_id = i.agency_id AND s.id = i.sender_profile_id
                   JOIN matrimony.member_profiles r ON r.agency_id = i.agency_id AND r.id = i.recipient_profile_id
                  WHERE m.agency_id = $1 AND m.id = e.subject_id),
                (SELECT p.full_name || ' (' || p.member_code || ')' FROM matrimony.client_notes n
                   JOIN matrimony.member_profiles p ON p.agency_id = n.agency_id AND p.id = n.profile_id
                  WHERE n.agency_id = $1 AND n.id = e.subject_id),
                (SELECT p.full_name || ' (' || p.member_code || ')' FROM matrimony.profile_guardians g
                   JOIN matrimony.member_profiles p ON p.agency_id = g.agency_id AND p.id = g.profile_id
                  WHERE g.agency_id = $1 AND g.id = e.subject_id),
                (SELECT p.full_name || ' (' || p.member_code || ')' FROM matrimony.profile_verifications v
                   JOIN matrimony.member_profiles p ON p.agency_id = v.agency_id AND p.id = v.profile_id
                  WHERE v.agency_id = $1 AND v.id = e.subject_id),
                (SELECT s.full_name || ' · ' || r.full_name FROM matrimony.chat_conversations ch
                   JOIN matrimony.member_profiles s ON s.agency_id = ch.agency_id AND s.id = ch.profile_a
                   JOIN matrimony.member_profiles r ON r.agency_id = ch.agency_id AND r.id = ch.profile_b
                  WHERE ch.agency_id = $1 AND ch.id = e.subject_id),
                (SELECT s.full_name || ' · ' || r.full_name FROM matrimony.couple_matches cm
                   JOIN matrimony.member_profiles s ON s.agency_id = cm.agency_id AND s.id = cm.profile_a
                   JOIN matrimony.member_profiles r ON r.agency_id = cm.agency_id AND r.id = cm.profile_b
                  WHERE cm.agency_id = $1 AND cm.id = e.subject_id)
              ) AS subject,
              sp.id AS profile_id
         FROM e
         LEFT JOIN matrimony.accounts a ON a.agency_id = $1 AND a.id = e.actor_id
         LEFT JOIN matrimony.member_profiles sp ON sp.agency_id = $1 AND sp.id = e.subject_id
         LEFT JOIN matrimony.accounts sa ON sa.agency_id = $1 AND sa.id = e.subject_id
        WHERE ($7::text IS NULL OR a.display_name ILIKE '%' || $7 || '%')
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $8`,
      [
        agencyId,
        filter.prefixes,
        filter.from,
        filter.to,
        page.after?.createdAt ?? null,
        page.after?.id ?? null,
        filter.text,
        page.limit + 1,
      ],
    );
    return (result.rows as Row[]).map((r) => ({
      id: r.id as string,
      type: r.type as string,
      at: new Date((r.occurred_at as string | null) ?? (r.created_at as Date)).toISOString(),
      actor: r.actor_id
        ? {
            id: r.actor_id as string,
            name: (r.actor_name as string | null) ?? '—',
            role: (r.actor_role as string | null) ?? '',
          }
        : null,
      subject: (r.subject as string | null) ?? null,
      profileId: (r.profile_id as string | null) ?? null,
      position: r.position as string,
    }));
  }
}
