import {
  MESSAGED_TEMPLATES,
  type MessageChannel,
  type MessageUsage,
} from '../../../bo/messaging.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

/** Who agreed to texts, what is still to be sent, and what was sent (see bo/messaging.ts). */
export class MessagingRepository {
  async preference(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT channel FROM matrimony.message_preferences WHERE agency_id = $1 AND account_id = $2`,
      [agencyId, accountId],
    );
    return ((result.rows[0] as Row | undefined)?.channel as MessageChannel | undefined) ?? 'none';
  }

  async setPreference(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    channel: MessageChannel,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.message_preferences (agency_id, account_id, channel, consented_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'none' THEN NULL ELSE now() END)
       ON CONFLICT (agency_id, account_id) DO UPDATE
         SET channel = EXCLUDED.channel, consented_at = EXCLUDED.consented_at, updated_at = now()`,
      [agencyId, accountId, channel],
    );
  }

  /** The account's phone and language, for the person asking and for a message about to go. */
  async contact(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT role, phone_e164, phone_verified_at IS NOT NULL AS verified, locale, status
         FROM matrimony.accounts WHERE agency_id = $1 AND id = $2 AND erased_at IS NULL`,
      [agencyId, accountId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          role: row.role as string,
          phone: (row.phone_e164 as string | null) ?? null,
          verified: row.verified === true,
          locale: (row.locale === 'en' ? 'en' : 'bn') as 'bn' | 'en',
          active: row.status === 'active',
        }
      : null;
  }

  /** Everything waiting now was there before the person agreed, and is not sent. */
  async markAllHandled(tx: Transaction, agencyId: string, accountId: string): Promise<void> {
    await tx.query(
      `UPDATE matrimony.notifications SET messaged_at = now()
        WHERE agency_id = $1 AND recipient_account_id = $2 AND messaged_at IS NULL`,
      [agencyId, accountId],
    );
  }

  /**
   * Takes the inbox lines not yet handled, in one statement, so two API processes never send the same line.
   * Every line taken is marked handled; those worth a text and no older than a day are returned (a line that
   * waited longer is stale news).
   */
  async claim(tx: Transaction, agencyId: string, accountId: string): Promise<string[]> {
    const result = await tx.query(
      `UPDATE matrimony.notifications SET messaged_at = now()
        WHERE agency_id = $1 AND recipient_account_id = $2 AND messaged_at IS NULL
        RETURNING template_key, created_at > now() - interval '1 day' AS fresh`,
      [agencyId, accountId],
    );
    return (result.rows as { template_key: string; fresh: boolean }[])
      .filter(
        (row) => row.fresh && (MESSAGED_TEMPLATES as readonly string[]).includes(row.template_key),
      )
      .map((row) => row.template_key);
  }

  /** The people who agreed to texts and have lines waiting: what a restart, or the end of the quiet hours, missed. */
  async waiting(tx: Transaction, agencyId: string, limit: number): Promise<string[]> {
    const result = await tx.query(
      `SELECT DISTINCT p.account_id
         FROM matrimony.message_preferences p
         JOIN matrimony.notifications n ON n.agency_id = p.agency_id
          AND n.recipient_account_id = p.account_id AND n.messaged_at IS NULL
        WHERE p.agency_id = $1 AND p.channel <> 'none' AND n.template_key = ANY($2::text[])
        LIMIT $3`,
      [agencyId, MESSAGED_TEMPLATES, limit],
    );
    return (result.rows as { account_id: string }[]).map((row) => row.account_id);
  }

  async log(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    channel: Exclude<MessageChannel, 'none'>,
    kinds: readonly string[],
    status: 'sent' | 'failed',
  ): Promise<void> {
    await tx.query(
      `INSERT INTO matrimony.outbound_messages (agency_id, account_id, channel, kinds, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [agencyId, accountId, channel, kinds, status],
    );
  }

  /** How many texts this member has been sent today (Bangladesh time). */
  async sentToday(tx: Transaction, agencyId: string, accountId: string): Promise<number> {
    const result = await tx.query(
      `SELECT count(*)::int AS n FROM matrimony.outbound_messages
        WHERE agency_id = $1 AND account_id = $2 AND status = 'sent'
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka'`,
      [agencyId, accountId],
    );
    return (result.rows[0] as { n: number }).n;
  }

  /** What was sent: today and this month in Bangladesh time. */
  async usage(
    tx: Transaction,
    agencyId: string,
  ): Promise<Pick<MessageUsage, 'today' | 'thisMonth' | 'failedToday'>> {
    const result = await tx.query(
      `WITH bounds AS (
         SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka' AS day,
                date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka' AS month)
       SELECT count(*) FILTER (WHERE m.created_at >= b.day AND m.status = 'sent')::int AS today,
              count(*) FILTER (WHERE m.created_at >= b.month AND m.status = 'sent')::int AS month,
              count(*) FILTER (WHERE m.created_at >= b.day AND m.status = 'failed')::int AS failed
         FROM bounds b
         LEFT JOIN matrimony.outbound_messages m ON m.agency_id = $1 AND m.created_at >= b.month`,
      [agencyId],
    );
    const row = result.rows[0] as Row;
    return {
      today: row.today as number,
      thisMonth: row.month as number,
      failedToday: row.failed as number,
    };
  }
}
