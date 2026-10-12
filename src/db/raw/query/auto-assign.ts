/**
 * Gives a profile that has no agent to the active agent who looks after the fewest clients (the
 * earliest account breaks a tie), records it in the history and tells that agent. Does nothing when
 * the profile already has an agent or the agency has no active agent. $1 agency, $2 profile.
 * Returns the agent chosen, or no row.
 */
export const autoAssign = `WITH chosen AS (
    SELECT a.id
      FROM matrimony.accounts a
     WHERE a.agency_id = $1 AND a.role = 'agent' AND a.status = 'active'
     ORDER BY (SELECT count(*) FROM matrimony.member_profiles p
                WHERE p.agency_id = a.agency_id AND p.assigned_agent_id = a.id),
              a.created_at, a.id
     LIMIT 1
  ), assigned AS (
    UPDATE matrimony.member_profiles p SET assigned_agent_id = (SELECT id FROM chosen)
     WHERE p.agency_id = $1 AND p.id = $2 AND p.assigned_agent_id IS NULL
       AND EXISTS (SELECT 1 FROM chosen)
    RETURNING p.id, p.assigned_agent_id
  ), recorded AS (
    INSERT INTO matrimony.client_assignments (agency_id, profile_id, from_agent_id, to_agent_id, changed_by_account_id, reason)
    SELECT $1, id, NULL, assigned_agent_id, NULL, 'automatic' FROM assigned
    RETURNING 1
  ), told AS (
    INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
    SELECT $1, assigned_agent_id, 'client-assigned:' || id::text || ':' || gen_random_uuid()::text,
           'client.assigned',
           jsonb_build_object('forProfileId', id, 'aboutProfileId', id)
      FROM assigned
    RETURNING 1
  )
  SELECT assigned_agent_id FROM assigned`;
