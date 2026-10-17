import { selectionFor } from './match.js';
import type { VisibleField } from '../../../bo/release.js';

/**
 * Connection requests are stored in the `interests` table of the original design, and the inbox in
 * `notifications`. The column names are turned into the ones the code uses (from, to, shared) at
 * the edge of each query.
 */
const POSITION = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CONNECTION = `id, sender_profile_id AS from_profile_id, recipient_profile_id AS to_profile_id, status,
   (sender_contact_consent_at IS NOT NULL) AS from_shared_contact,
   (recipient_contact_consent_at IS NOT NULL) AS to_shared_contact`;

/** The interest of a pair of profiles, whichever of them asked. $1 agency, $2 and $3 the two profiles. */
const BETWEEN = `agency_id = $1
   AND ((sender_profile_id = $2 AND recipient_profile_id = $3)
     OR (sender_profile_id = $3 AND recipient_profile_id = $2))`;

export const connectionQueries = {
  // $1 agency, $2 and $3 the two profiles of an accepted connection, $4 who accepted. Each becomes a
  // released candidate of the other. A fit already measured is kept; one never measured has none.
  releaseBoth: `INSERT INTO matrimony.client_candidates
   (agency_id, client_profile_id, candidate_profile_id, state, met_count, unmet_count, unknown_count,
    criteria, decided_by, decided_at)
 SELECT $1::uuid, t.client, t.candidate, 'released', 0, 0, 0, '{"forward": [], "reverse": []}'::jsonb, $4::uuid, now()
   FROM (VALUES ($2::uuid, $3::uuid), ($3::uuid, $2::uuid)) AS t(client, candidate)
 ON CONFLICT (agency_id, client_profile_id, candidate_profile_id) DO UPDATE
   SET state = 'released', decided_by = EXCLUDED.decided_by, decided_at = now(), updated_at = now()
 WHERE matrimony.client_candidates.state <> 'released'`,

  // $1 agency, $2 the profiles. Locks them in a fixed order, so two people asking each other cannot deadlock.
  lockProfiles: `SELECT id, status, service_mode, owner_account_id, assigned_agent_id
   FROM matrimony.member_profiles
  WHERE agency_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,

  // The same, without locking: for reading who the two sides are before taking the locks.
  readProfiles: `SELECT id, status, service_mode, owner_account_id, assigned_agent_id
   FROM matrimony.member_profiles WHERE agency_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,

  // $1 agency, $2 client, $3 candidate. In the client's released window and still published.
  released: `SELECT 1 FROM matrimony.client_candidates c
   JOIN matrimony.member_profiles m ON m.agency_id = c.agency_id AND m.id = c.candidate_profile_id
  WHERE c.agency_id = $1 AND c.client_profile_id = $2 AND c.candidate_profile_id = $3
    AND c.state = 'released' AND m.status = 'active'`,

  pair: `SELECT ${CONNECTION} FROM matrimony.interests WHERE ${BETWEEN}`,
  byId: `SELECT ${CONNECTION} FROM matrimony.interests WHERE agency_id = $1 AND id = $2`,

  // $1 agency, $2 from, $3 to, $4 who, $5 where it starts (in_review or pending), $6 the note or null.
  insert: `INSERT INTO matrimony.interests (agency_id, sender_profile_id, recipient_profile_id, initiated_by_account_id,
                                        status, note, review_started_at)
 VALUES ($1, $2, $3, $4, $5::text, $6::text, CASE WHEN $5::text = 'in_review' THEN now() END) RETURNING id`,

  // A withdrawn request asked again, by either side. $1 agency, $2 interest, $3 from, $4 to, $5 who,
  // $6 where it starts, $7 the note or null. The review and reminder history starts again too.
  repend: `UPDATE matrimony.interests
   SET sender_profile_id = $3, recipient_profile_id = $4, status = $6::text, initiated_by_account_id = $5,
       note = $7::text, responded_by_account_id = NULL, responded_at = NULL, sender_contact_consent_at = NULL,
       recipient_contact_consent_at = NULL, reviewed_by_account_id = NULL, reviewed_at = NULL,
       review_started_at = CASE WHEN $6::text = 'in_review' THEN now() END, reminders_sent = 0,
       last_reminded_at = NULL, created_at = now(), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'withdrawn' RETURNING id`,

  // $1 agency, $2 interest, $3 approve (true) or reject (false), $4 the reviewer. Only a request
  // still waiting for review can be decided. A rejection ends it as declined, so the asker is told so.
  reviewDecide: `UPDATE matrimony.interests
   SET status = CASE WHEN $3::boolean THEN 'pending' ELSE 'declined' END::text,
       reviewed_by_account_id = $4::uuid, reviewed_at = now(),
       responded_by_account_id = CASE WHEN $3::boolean THEN NULL ELSE $4::uuid END,
       responded_at = CASE WHEN $3::boolean THEN NULL ELSE now() END,
       updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'in_review' RETURNING id`,

  // $1 agency, $2 interest. A declined pair can be asked again, by either side.
  reopen: `UPDATE matrimony.interests SET status = 'withdrawn', updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'declined' RETURNING id`,

  // $1 agency. The admins, who review when nobody looks after the person asked.
  admins: `SELECT id FROM matrimony.accounts WHERE agency_id = $1 AND role = 'admin' AND status = 'active'
 ORDER BY id`,

  /**
   * $1 agency, $2 whether the reader is an admin, $3 the reader, $4 cursor time, $5 cursor id,
   * $6 limit. Oldest first, so the request that has waited longest is on top. An admin sees every
   * request; an agent only those for the clients assigned to them.
   */
  reviewQueue: `SELECT x.id AS connection_id, x.created_at, x.note, x.reminders_sent,
       x.review_started_at, ${POSITION('x.review_started_at')} AS position,
       a.id AS from_id, a.member_code AS from_code, a.full_name AS from_name,
       to_char(a.date_of_birth, 'YYYY-MM-DD') AS from_dob, a.profession_code AS from_profession,
       a.current_district_code AS from_district,
       b.id AS to_id, b.member_code AS to_code, b.full_name AS to_name,
       to_char(b.date_of_birth, 'YYYY-MM-DD') AS to_dob, b.profession_code AS to_profession,
       b.current_district_code AS to_district
  FROM matrimony.interests x
  JOIN matrimony.member_profiles a ON a.agency_id = x.agency_id AND a.id = x.sender_profile_id
  JOIN matrimony.member_profiles b ON b.agency_id = x.agency_id AND b.id = x.recipient_profile_id
 WHERE x.agency_id = $1 AND x.status = 'in_review'
   AND ($2::boolean OR b.assigned_agent_id = $3::uuid)
   AND ($4::timestamptz IS NULL OR (x.review_started_at, x.id) > ($4::timestamptz, $5::uuid))
 ORDER BY x.review_started_at ASC, x.id ASC
 LIMIT $6`,

  // $1 agency, $2 whether the reader is an admin, $3 the reader.
  reviewCount: `SELECT count(*)::int AS total
  FROM matrimony.interests x
  JOIN matrimony.member_profiles b ON b.agency_id = x.agency_id AND b.id = x.recipient_profile_id
 WHERE x.agency_id = $1 AND x.status = 'in_review'
   AND ($2::boolean OR b.assigned_agent_id = $3::uuid)`,

  /**
   * $1 agency, $2 now, $3 the first reminder after (seconds), $4 each later one after (seconds),
   * $5 limit. Requests whose next reminder is due, oldest first, with who looks after the person
   * asked and the asker, so the reminder can say who. Locked so two job runs never remind twice.
   */
  dueReminders: `SELECT x.id, x.review_started_at, x.reminders_sent,
       x.sender_profile_id AS from_profile_id, x.recipient_profile_id AS to_profile_id,
       b.assigned_agent_id
  FROM matrimony.interests x
  JOIN matrimony.member_profiles b ON b.agency_id = x.agency_id AND b.id = x.recipient_profile_id
 WHERE x.agency_id = $1 AND x.status = 'in_review'
   AND CASE WHEN x.reminders_sent = 0
            THEN x.review_started_at <= $2::timestamptz - make_interval(secs => $3::int)
            ELSE x.last_reminded_at <= $2::timestamptz - make_interval(secs => $4::int) END
 ORDER BY x.review_started_at ASC, x.id ASC
 LIMIT $5
 FOR UPDATE OF x SKIP LOCKED`,

  // $1 agency, $2 interest, $3 now.
  markReminded: `UPDATE matrimony.interests SET reminders_sent = reminders_sent + 1, last_reminded_at = $3::timestamptz
 WHERE agency_id = $1 AND id = $2 AND status = 'in_review' RETURNING id`,

  // $1 agency, $2 interest, $3 accepted or declined, $4 who. Only a request still waiting can be answered.
  respond: `UPDATE matrimony.interests
   SET status = $3, responded_by_account_id = $4, responded_at = now(), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,

  // $1 agency, $2 interest, $3 the profile that asked. A request can be taken back while it waits for review too.
  withdraw: `UPDATE matrimony.interests SET status = 'withdrawn', updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status IN ('in_review', 'pending') AND sender_profile_id = $3 RETURNING id`,

  shareFrom: `UPDATE matrimony.interests SET sender_contact_consent_at = COALESCE(sender_contact_consent_at, now()), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'accepted' AND sender_profile_id = $3 RETURNING id`,
  shareTo: `UPDATE matrimony.interests SET recipient_contact_consent_at = COALESCE(recipient_contact_consent_at, now()), updated_at = now()
 WHERE agency_id = $1 AND id = $2 AND status = 'accepted' AND recipient_profile_id = $3 RETURNING id`,

  // $1 agency, $2 recipient, $3 event key (unique for the recipient), $4 template, $5 payload.
  notify: `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
 VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (agency_id, recipient_account_id, event_key) DO NOTHING`,

  // $1 agency, $2 recipient, $3 cursor time, $4 cursor id, $5 limit, $6 whether the recipient may see names.
  // Filters, each null when not used: $7 template keys, $8 read (true) or unread (false), $9 from day,
  // $10 to day (both inclusive, in Bangladesh time), $11 search text (already escaped for LIKE), $12 the
  // client the line is for. The search looks at member codes, and at names only when $6 allows names.
  notifications: `SELECT n.id, n.template_key, n.payload, n.created_at, ${POSITION('n.created_at')} AS position,
       (n.read_at IS NOT NULL) AS is_read,
       m.id AS about_profile_id, m.member_code, CASE WHEN $6::boolean THEN m.full_name END AS full_name
  FROM matrimony.notifications n
  LEFT JOIN matrimony.member_profiles m ON m.agency_id = n.agency_id AND m.id = (n.payload->>'aboutProfileId')::uuid
  LEFT JOIN matrimony.member_profiles f ON f.agency_id = n.agency_id AND f.id = (n.payload->>'forProfileId')::uuid
 WHERE n.agency_id = $1 AND n.recipient_account_id = $2
   AND ($3::timestamptz IS NULL OR (n.created_at, n.id) < ($3::timestamptz, $4::uuid))
   AND ($7::text[] IS NULL OR n.template_key = ANY($7::text[]))
   AND ($8::boolean IS NULL OR (n.read_at IS NOT NULL) = $8::boolean)
   AND ($9::date IS NULL OR n.created_at >= ($9::date)::timestamp AT TIME ZONE 'Asia/Dhaka')
   AND ($10::date IS NULL OR n.created_at < (($10::date + 1))::timestamp AT TIME ZONE 'Asia/Dhaka')
   AND ($12::uuid IS NULL OR n.payload->>'forProfileId' = $12::text)
   AND ($11::text IS NULL
        OR m.member_code ILIKE '%' || $11 || '%'
        OR f.member_code ILIKE '%' || $11 || '%'
        OR ($6::boolean AND (m.full_name ILIKE '%' || $11 || '%' OR f.full_name ILIKE '%' || $11 || '%')))
 ORDER BY n.created_at DESC, n.id DESC
 LIMIT $5`,

  // $1 agency, $2 recipient. The same lines the inbox lists, so the count matches what is shown.
  unreadCount: `SELECT count(*)::int AS unread FROM matrimony.notifications
 WHERE agency_id = $1 AND recipient_account_id = $2 AND read_at IS NULL`,

  // $1 agency, $2 recipient, $3 the lines to mark, or null for every unread line. Only the
  // recipient's own, and only the ones not read yet, so a repeat changes nothing.
  markRead: `UPDATE matrimony.notifications SET read_at = now()
 WHERE agency_id = $1 AND recipient_account_id = $2 AND read_at IS NULL
   AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
 RETURNING id`,

  /**
   * $1 agency, $2 the viewer's profile, $3 the box, $4 cursor time, $5 cursor id, $6 limit. The
   * other person with only the fields the viewer may see. A profile that is no longer published is left out.
   */
  list: (
    visible: readonly VisibleField[],
  ) => `SELECT x.id AS connection_id, x.status AS connection_status,
       (x.sender_profile_id = $2) AS connection_sent,
       (x.sender_contact_consent_at IS NOT NULL) AS from_shared,
       (x.recipient_contact_consent_at IS NOT NULL) AS to_shared, x.created_at, x.responded_at,
       CASE WHEN x.recipient_profile_id = $2 THEN x.note END AS note,
       ${POSITION('x.updated_at')} AS position, m.id, m.member_code,
       (m.verified_at IS NOT NULL) AS verified,
       ga.advice, ga.note AS advice_note, ga.advised_at AS advice_at${selectionFor(visible)}
  FROM matrimony.interests x
  JOIN matrimony.member_profiles m ON m.agency_id = x.agency_id
   AND m.id = CASE WHEN x.sender_profile_id = $2 THEN x.recipient_profile_id ELSE x.sender_profile_id END
  LEFT JOIN matrimony.guardian_advice ga ON ga.agency_id = x.agency_id AND ga.interest_id = x.id
   AND ga.profile_id = $2
 WHERE x.agency_id = $1 AND (x.sender_profile_id = $2 OR x.recipient_profile_id = $2) AND m.status = 'active'
   AND (($3 = 'received' AND x.status = 'pending' AND x.recipient_profile_id = $2)
     OR ($3 = 'sent' AND x.status IN ('in_review', 'pending') AND x.sender_profile_id = $2)
     OR ($3 = 'connected' AND x.status = 'accepted'))
   AND ($4::timestamptz IS NULL OR (x.updated_at, x.id) < ($4::timestamptz, $5::uuid))
 ORDER BY x.updated_at DESC, x.id DESC
 LIMIT $6`,

  // $1 agency, $2 the client's profile. Every connection of this client, for the staff who look after them.
  staffList: `SELECT x.id AS connection_id, x.status, (x.sender_profile_id = $2) AS sent,
       x.created_at, x.responded_at,
       (x.sender_contact_consent_at IS NOT NULL) AS from_shared_contact,
       (x.recipient_contact_consent_at IS NOT NULL) AS to_shared_contact,
       m.id, m.member_code, m.full_name, to_char(m.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
       m.profession_code, m.current_district_code, m.service_mode,
       ga.advice, ga.note AS advice_note, ga.advised_at AS advice_at
  FROM matrimony.interests x
  JOIN matrimony.member_profiles m ON m.agency_id = x.agency_id
   AND m.id = CASE WHEN x.sender_profile_id = $2 THEN x.recipient_profile_id ELSE x.sender_profile_id END
  LEFT JOIN matrimony.guardian_advice ga ON ga.agency_id = x.agency_id AND ga.interest_id = x.id
   AND ga.profile_id = $2
 WHERE x.agency_id = $1 AND (x.sender_profile_id = $2 OR x.recipient_profile_id = $2)
 ORDER BY x.updated_at DESC, x.id DESC
 LIMIT 100`,
};
