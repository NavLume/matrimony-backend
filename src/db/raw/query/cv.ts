// A CV with whether staff uploaded it, which is what the owner is told.
const COLUMNS = `c.id, c.storage_key, c.file_name, c.byte_size, c.status, c.created_at, c.reviewer_notes,
 (u.role <> 'member') AS by_staff`;
const FROM = `FROM matrimony.profile_cvs c
 JOIN matrimony.accounts u ON u.agency_id = c.agency_id AND u.id = c.uploaded_by_account_id`;

export const cvQueries = {
  // $1 agency, $2 owner account. Locks the profile so two uploads for one member run one after the other.
  lockOwnProfile: `SELECT id, status, service_mode, assigned_agent_id FROM matrimony.member_profiles
 WHERE agency_id = $1 AND owner_account_id = $2 FOR UPDATE`,
  ownProfile: `SELECT id, status, service_mode, assigned_agent_id FROM matrimony.member_profiles
 WHERE agency_id = $1 AND owner_account_id = $2`,
  // $1 agency, $2 profile.
  lockProfile: `SELECT id, status, service_mode, assigned_agent_id FROM matrimony.member_profiles
 WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
  profile: `SELECT id, status, service_mode, assigned_agent_id FROM matrimony.member_profiles
 WHERE agency_id = $1 AND id = $2`,

  // $1 agency, $2 profile. Every CV of the profile that is not removed, newest first.
  live: `SELECT ${COLUMNS} ${FROM}
 WHERE c.agency_id = $1 AND c.profile_id = $2 AND c.status <> 'removed'
 ORDER BY c.created_at DESC`,
  // $1 agency, $2 profile. The one others may see.
  published: `SELECT ${COLUMNS} ${FROM}
 WHERE c.agency_id = $1 AND c.profile_id = $2 AND c.status = 'published'`,

  // $1 agency, $2 id, $3 profile, $4 storage key, $5 file name, $6 size, $7 status, $8 uploader.
  insert: `INSERT INTO matrimony.profile_cvs
 (agency_id, id, profile_id, storage_key, file_name, byte_size, status, uploaded_by_account_id)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,

  // $1 agency, $2 id. A removed CV keeps its row; its file is deleted from storage.
  markRemoved: `UPDATE matrimony.profile_cvs SET status = 'removed' WHERE agency_id = $1 AND id = $2`,

  // $1 agency, $2 id, $3 approve, $4 reviewer, $5 notes. Only one still waiting can be decided.
  decide: `UPDATE matrimony.profile_cvs
   SET status = CASE WHEN $3::boolean THEN 'published' ELSE 'rejected' END::text,
       reviewed_by_account_id = $4::uuid, reviewed_at = now(), reviewer_notes = $5::text
 WHERE agency_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,

  // $1 agency, $2 and $3 the two profiles. Whether an accepted connection joins them.
  accepted: `SELECT 1 FROM matrimony.interests
 WHERE agency_id = $1 AND status = 'accepted'
   AND ((sender_profile_id = $2 AND recipient_profile_id = $3)
     OR (sender_profile_id = $3 AND recipient_profile_id = $2))`,
};
