// Client management's SQL. Writes to a profile itself (its content, its status) go through the
// profile queries; this is the list, the lookups around it and the assignment.
const ITEM = `p.id, p.member_code, p.full_name, p.status, p.service_mode, p.version, p.updated_at,
 to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position,
 p.assigned_agent_id, a.display_name AS agent_name, p.current_district_code,
 EXISTS (
   SELECT 1 FROM matrimony.profile_reviews r
   WHERE r.agency_id = p.agency_id AND r.profile_id = p.id AND r.status = 'pending'
     AND r.kind IN ('initial_submission', 'field_update')
 ) AS has_pending_review,
 p.verified_at IS NOT NULL AS verified`;

/**
 * One page of clients, most recently changed first. $1 agency; $2 the agent whose view this is
 * (an agent sees only their own), or null for an admin; $3 status; $4 service mode; $5 an agent to
 * show (admin filter) or null; $6 true to show only unassigned (admin filter); $7 a LIKE pattern
 * for the name or member code, or null; $8 and $9 the position to continue after; $10 how many.
 */
export const clientListQuery = `SELECT ${ITEM}
 FROM matrimony.member_profiles p
 LEFT JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.assigned_agent_id
 WHERE p.agency_id = $1
   AND ($2::uuid IS NULL OR p.assigned_agent_id = $2)
   AND ($3::text IS NULL OR p.status = $3)
   AND ($4::text IS NULL OR p.service_mode = $4)
   AND ($5::uuid IS NULL OR p.assigned_agent_id = $5)
   AND (NOT $6::boolean OR p.assigned_agent_id IS NULL)
   AND ($7::text IS NULL OR p.full_name ILIKE $7 ESCAPE '\\' OR p.member_code ILIKE $7 ESCAPE '\\')
   AND ($8::timestamptz IS NULL OR (p.updated_at, p.id) < ($8::timestamptz, $9::uuid))
 ORDER BY p.updated_at DESC, p.id DESC
 LIMIT $10`;

export const clientQueries = {
  // Who looks after a profile and, for a member's own, who the member is.
  meta: `SELECT p.service_mode, p.assigned_agent_id, a.display_name AS agent_name,
 p.owner_account_id, o.display_name AS owner_name
 FROM matrimony.member_profiles p
 LEFT JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.assigned_agent_id
 LEFT JOIN matrimony.accounts o ON o.agency_id = p.agency_id AND o.id = p.owner_account_id
 WHERE p.agency_id = $1 AND p.id = $2`,

  staff: `SELECT id, display_name, email, role, status,
       (SELECT count(*)::int FROM matrimony.member_profiles p
         WHERE p.agency_id = a.agency_id AND p.assigned_agent_id = a.id) AS client_count
  FROM matrimony.accounts a
 WHERE a.agency_id = $1 AND a.role IN ('admin', 'agent') ORDER BY a.role, a.display_name`,
  staffMember: `SELECT id, display_name, email, role, status,
       (SELECT count(*)::int FROM matrimony.member_profiles p
         WHERE p.agency_id = a.agency_id AND p.assigned_agent_id = a.id) AS client_count
  FROM matrimony.accounts a
 WHERE a.agency_id = $1 AND a.id = $2 AND a.role IN ('admin', 'agent')`,

  // $1 agency, $2 account, $3 the new status. Only staff, and only between active and disabled.
  setStatus: `UPDATE matrimony.accounts SET status = $3
 WHERE agency_id = $1 AND id = $2 AND role IN ('admin', 'agent')
   AND status IN ('active', 'disabled') AND status <> $3 RETURNING id`,
  activeAdmins: `SELECT count(*)::int AS n FROM matrimony.accounts
 WHERE agency_id = $1 AND role = 'admin' AND status = 'active'`,

  // Everything one agent looks after goes to another (or to nobody), and each move is recorded.
  // $1 agency, $2 from, $3 to or null, $4 who.
  handOver: `WITH moved AS (
    UPDATE matrimony.member_profiles SET assigned_agent_id = $3::uuid
     WHERE agency_id = $1 AND assigned_agent_id = $2 RETURNING id
  ), recorded AS (
    INSERT INTO matrimony.client_assignments (agency_id, profile_id, from_agent_id, to_agent_id, changed_by_account_id, reason)
    SELECT $1, id, $2, $3::uuid, $4, 'handed_over' FROM moved RETURNING profile_id
  ), told AS (
    INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
    SELECT $1, $3::uuid, 'client-assigned:' || id::text || ':' || gen_random_uuid()::text, 'client.assigned',
           jsonb_build_object('forProfileId', id, 'aboutProfileId', id)
      FROM moved WHERE $3::uuid IS NOT NULL AND $3::uuid IS DISTINCT FROM $4::uuid
    RETURNING 1
  ), told_clients AS (
    -- Each client who signs in is told who looks after them now.
    INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
    SELECT $1, p.owner_account_id, 'client-update:' || p.id::text || ':' || gen_random_uuid()::text, 'client.update',
           jsonb_build_object('forProfileId', p.id, 'aboutProfileId', p.id, 'what', 'agent_assigned',
                              'name', a.display_name, 'role', 'agent')
      FROM moved m
      JOIN matrimony.member_profiles p ON p.agency_id = $1 AND p.id = m.id AND p.owner_account_id IS NOT NULL
      JOIN matrimony.accounts a ON a.agency_id = $1 AND a.id = $3::uuid
     WHERE $3::uuid IS NOT NULL AND p.owner_account_id IS DISTINCT FROM $4::uuid
    RETURNING 1
  )
  SELECT profile_id FROM recorded`,

  // $1 agency, $2 profile, $3 from, $4 to, $5 who. The new agent is told, unless they did it themselves.
  recordAssignment: `WITH recorded AS (
    INSERT INTO matrimony.client_assignments
     (agency_id, profile_id, from_agent_id, to_agent_id, changed_by_account_id, reason)
     VALUES ($1, $2, $3, $4::uuid, $5, 'assigned')
  )
  INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
  SELECT $1, $4::uuid, 'client-assigned:' || $2::uuid::text || ':' || gen_random_uuid()::text, 'client.assigned',
         jsonb_build_object('forProfileId', $2::uuid, 'aboutProfileId', $2::uuid)
   WHERE $4::uuid IS NOT NULL AND $4::uuid IS DISTINCT FROM $5::uuid`,

  // $1 agency, $2 profile. Newest first.
  assignments: `SELECT x.id, x.created_at, x.reason,
       f.id AS from_id, f.display_name AS from_name,
       t.id AS to_id, t.display_name AS to_name,
       b.id AS by_id, b.display_name AS by_name
  FROM matrimony.client_assignments x
  LEFT JOIN matrimony.accounts f ON f.agency_id = x.agency_id AND f.id = x.from_agent_id
  LEFT JOIN matrimony.accounts t ON t.agency_id = x.agency_id AND t.id = x.to_agent_id
  LEFT JOIN matrimony.accounts b ON b.agency_id = x.agency_id AND b.id = x.changed_by_account_id
 WHERE x.agency_id = $1 AND x.profile_id = $2
 ORDER BY x.created_at DESC, x.id DESC`,

  // Changes who looks after a profile, nothing else (the database does not raise the profile's
  // version for this, so requests waiting for review stay valid).
  // Locks the profile and says who looked after it, so the change that follows is recorded against
  // the right "from" even when two admins act at once.
  assignee: `SELECT assigned_agent_id FROM matrimony.member_profiles
 WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
  assign: `UPDATE matrimony.member_profiles SET assigned_agent_id = $3
 WHERE agency_id = $1 AND id = $2 RETURNING id`,
};
