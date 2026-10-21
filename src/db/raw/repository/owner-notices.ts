import type { Transaction } from '../../config/database.js';
import type { WorkflowEvent } from '../../../bo/event.js';

/**
 * Inbox lines for the person a profile belongs to (a member or client who signs in), written beside the
 * event that causes them, in the same transaction (20 October 2026: whatever staff do that a client must
 * know about shows in their inbox). Never for the person who did it, and never for a profile with no login.
 *
 * The line is one kind (`client.update`); `what` says which: status_paused, status_active, status_closed,
 * matched, unmatched, verification_revoked, payment_recorded, payment_voided, payment_amount_changed,
 * agreement_set, photo_added, photo_removed, cv_removed, review_cancelled, agent_assigned. `count` carries an amount in
 * taka and `name` the agent's name.
 */
export type OwnerUpdate =
  | 'status_paused'
  | 'status_active'
  | 'status_closed'
  | 'matched'
  | 'unmatched'
  | 'verification_revoked'
  | 'payment_recorded'
  | 'payment_voided'
  | 'payment_amount_changed'
  | 'agreement_set'
  | 'photo_added'
  | 'photo_removed'
  | 'cv_removed'
  | 'review_cancelled'
  | 'agent_assigned';

type Row = Record<string, unknown>;

interface Told {
  profileId: string;
  what: OwnerUpdate;
  amount?: number;
  name?: string;
}

async function one(tx: Transaction, sql: string, params: unknown[]): Promise<Row | undefined> {
  return (await tx.query(sql, params)).rows[0] as Row | undefined;
}

/** What a payment event is about: the client, and the amount it concerns. */
async function paymentOf(tx: Transaction, agencyId: string, paymentId: string) {
  const row = await one(
    tx,
    `SELECT profile_id, amount::bigint AS amount FROM matrimony.client_payments WHERE agency_id = $1 AND id = $2`,
    [agencyId, paymentId],
  );
  return row ? { profileId: row.profile_id as string, amount: Number(row.amount) } : null;
}

async function toldBy(tx: Transaction, event: WorkflowEvent): Promise<Told[]> {
  const { agencyId, subjectId } = event;
  if (!subjectId) return [];
  switch (event.type) {
    case 'profile.status_changed': {
      const row = await one(
        tx,
        `SELECT status FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
        [agencyId, subjectId],
      );
      const what = { paused: 'status_paused', active: 'status_active', closed: 'status_closed' }[
        String(row?.status)
      ] as OwnerUpdate | undefined;
      // Matched has its own line, from the match itself.
      return what ? [{ profileId: subjectId, what }] : [];
    }
    case 'match.recorded':
    case 'match.undone': {
      const row = await one(
        tx,
        `SELECT profile_a, profile_b FROM matrimony.couple_matches WHERE agency_id = $1 AND id = $2`,
        [agencyId, subjectId],
      );
      if (!row) return [];
      const what = event.type === 'match.recorded' ? 'matched' : 'unmatched';
      return [
        { profileId: row.profile_a as string, what },
        { profileId: row.profile_b as string, what },
      ];
    }
    case 'verification.revoked':
      return [{ profileId: subjectId, what: 'verification_revoked' }];
    case 'profile.review_cancelled':
      return [{ profileId: subjectId, what: 'review_cancelled' }];
    case 'payment.recorded':
    case 'payment.voided':
    case 'payment.amount_changed': {
      const payment = await paymentOf(tx, agencyId, subjectId);
      if (!payment) return [];
      const what = {
        'payment.recorded': 'payment_recorded',
        'payment.voided': 'payment_voided',
        'payment.amount_changed': 'payment_amount_changed',
      }[event.type] as OwnerUpdate;
      return [{ profileId: payment.profileId, what, amount: payment.amount }];
    }
    case 'payment.agreement_set': {
      const row = await one(
        tx,
        `SELECT amount::bigint AS amount FROM matrimony.client_agreements
          WHERE agency_id = $1 AND profile_id = $2 AND stage = 'total'`,
        [agencyId, subjectId],
      );
      return row
        ? [{ profileId: subjectId, what: 'agreement_set', amount: Number(row.amount) }]
        : [];
    }
    case 'photo.uploaded':
    case 'photo.removed': {
      const row = await one(
        tx,
        `SELECT profile_id FROM matrimony.profile_photos WHERE agency_id = $1 AND id = $2`,
        [agencyId, subjectId],
      );
      return row
        ? [
            {
              profileId: row.profile_id as string,
              what: event.type === 'photo.uploaded' ? 'photo_added' : 'photo_removed',
            },
          ]
        : [];
    }
    case 'cv.removed': {
      const row = await one(
        tx,
        `SELECT profile_id FROM matrimony.profile_cvs WHERE agency_id = $1 AND id = $2`,
        [agencyId, subjectId],
      );
      return row ? [{ profileId: row.profile_id as string, what: 'cv_removed' }] : [];
    }
    case 'profile.assigned': {
      const row = await one(
        tx,
        `SELECT a.display_name FROM matrimony.member_profiles p
           JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.assigned_agent_id
          WHERE p.agency_id = $1 AND p.id = $2`,
        [agencyId, subjectId],
      );
      return row
        ? [{ profileId: subjectId, what: 'agent_assigned', name: row.display_name as string }]
        : [];
    }
    default:
      return [];
  }
}

/** Writes the inbox lines for an event, if it is one a client must know about. */
export async function notifyOwnerOfEvent(tx: Transaction, event: WorkflowEvent): Promise<void> {
  for (const told of await toldBy(tx, event)) {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       SELECT $1, p.owner_account_id, 'client-update:' || p.id::text || ':' || gen_random_uuid()::text,
              'client.update',
              jsonb_build_object('forProfileId', p.id, 'aboutProfileId', p.id, 'what', $4::text)
              || CASE WHEN $5::bigint IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('count', $5::bigint) END
              || CASE WHEN $6::text IS NULL THEN '{}'::jsonb
                      ELSE jsonb_build_object('name', $6::text, 'role', 'agent') END
         FROM matrimony.member_profiles p
        WHERE p.agency_id = $1 AND p.id = $2 AND p.owner_account_id IS NOT NULL
          AND p.owner_account_id IS DISTINCT FROM $3::uuid`,
      [
        event.agencyId,
        told.profileId,
        event.actorId,
        told.what,
        told.amount ?? null,
        told.name ?? null,
      ],
    );
  }
}
