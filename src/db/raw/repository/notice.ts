import type { Transaction } from '../../config/database.js';

/**
 * Inbox lines written beside the change that causes them, inside the same transaction, so a line
 * never exists for a change that did not happen. The inbox, the unread count and the live stream all
 * read the same `notifications` table.
 */

/** What was sent for review: shown in the staff member's inbox line. */
export type ReviewWhat = 'profile' | 'edit' | 'photo' | 'cv';

/**
 * Tells the staff who can review a profile that something waits for them: the agent who looks after
 * it and every active admin, but never the person who sent it. Nobody is told twice.
 */
export async function notifyReviewers(
  tx: Transaction,
  agencyId: string,
  profileId: string,
  submitterId: string,
  what: ReviewWhat,
): Promise<void> {
  await tx.query(
    `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
     SELECT $1, r.id, 'review-requested:' || $2::text || ':' || gen_random_uuid()::text,
            'profile.review_requested',
            jsonb_build_object('forProfileId', $2::uuid, 'aboutProfileId', $2::uuid, 'what', $4::text)
       FROM (
         SELECT a.id FROM matrimony.accounts a
          WHERE a.agency_id = $1 AND a.role = 'admin' AND a.status = 'active'
         UNION
         SELECT p.assigned_agent_id FROM matrimony.member_profiles p
           JOIN matrimony.accounts a
             ON a.agency_id = p.agency_id AND a.id = p.assigned_agent_id AND a.status = 'active'
          WHERE p.agency_id = $1 AND p.id = $2 AND p.assigned_agent_id IS NOT NULL
       ) r(id)
      WHERE r.id <> $3::uuid`,
    [agencyId, profileId, submitterId, what],
  );
}

/**
 * Tells a client who signs in that new profiles were released to them. A client with no login is not
 * told: their agent released the profiles and is the one who looks after them.
 */
export async function notifyReleased(
  tx: Transaction,
  agencyId: string,
  clientId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  await tx.query(
    `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
     SELECT $1, p.owner_account_id, 'released:' || p.id::text || ':' || gen_random_uuid()::text,
            'candidates.released',
            jsonb_build_object('forProfileId', p.id, 'aboutProfileId', p.id, 'count', $3::int)
       FROM matrimony.member_profiles p
      WHERE p.agency_id = $1 AND p.id = $2 AND p.owner_account_id IS NOT NULL`,
    [agencyId, clientId, count],
  );
}
