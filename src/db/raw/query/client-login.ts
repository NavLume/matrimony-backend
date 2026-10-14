// A client's login: the link sent to them, and the profile it is for.
const OPEN = `l.accepted_at IS NULL AND l.revoked_at IS NULL`;

export const clientLoginQueries = {
  // $1 agency, $2 profile.
  profile: `SELECT p.id, p.full_name, p.service_mode, p.owner_account_id, p.assigned_agent_id,
       o.display_name AS owner_name
  FROM matrimony.member_profiles p
  LEFT JOIN matrimony.accounts o ON o.agency_id = p.agency_id AND o.id = p.owner_account_id
 WHERE p.agency_id = $1 AND p.id = $2`,

  profileForUpdate: `SELECT p.id, p.full_name, p.service_mode, p.owner_account_id, p.assigned_agent_id,
       NULL::text AS owner_name
  FROM matrimony.member_profiles p
 WHERE p.agency_id = $1 AND p.id = $2 FOR UPDATE`,

  // The link still out for this profile, whether or not it can still be opened.
  // $1 agency, $2 profile.
  open: `SELECT l.id, l.channel, l.email, l.phone_e164, l.locale, l.expires_at,
       (l.expires_at <= now()) AS expired, u.display_name AS invited_by_name
  FROM matrimony.client_logins l
  JOIN matrimony.accounts u ON u.agency_id = l.agency_id AND u.id = l.created_by
 WHERE l.agency_id = $1 AND l.profile_id = $2 AND ${OPEN}`,

  // A link that can still be opened. $1 agency, $2 hash of the link.
  byLink: `SELECT l.id, l.profile_id, l.channel, l.email, l.phone_e164, l.locale, p.full_name,
       p.owner_account_id, p.service_mode
  FROM matrimony.client_logins l
  JOIN matrimony.member_profiles p ON p.agency_id = l.agency_id AND p.id = l.profile_id
 WHERE l.agency_id = $1 AND l.token_hash = $2 AND ${OPEN} AND l.expires_at > now()`,

  // $1 agency, $2 profile. Any link still out stops working.
  revokeOpen: `UPDATE matrimony.client_logins l SET revoked_at = now()
 WHERE l.agency_id = $1 AND l.profile_id = $2 AND ${OPEN}`,

  // $1 agency, $2 profile, $3 channel, $4 email, $5 phone, $6 locale, $7 hash, $8 days, $9 by.
  insert: `INSERT INTO matrimony.client_logins
 (agency_id, profile_id, channel, email, phone_e164, locale, token_hash, expires_at, created_by)
 VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8::int), $9)
 RETURNING id`,

  // The profile only gets an owner while it has none, so a link can never take over an account.
  // $1 agency, $2 profile, $3 account.
  attachOwner: `UPDATE matrimony.member_profiles SET owner_account_id = $3::uuid
 WHERE agency_id = $1 AND id = $2 AND owner_account_id IS NULL RETURNING id`,

  // $1 agency, $2 link, $3 account.
  markAccepted: `UPDATE matrimony.client_logins SET accepted_at = now(), accepted_account_id = $3::uuid
 WHERE agency_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
};
