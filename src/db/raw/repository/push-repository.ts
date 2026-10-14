import type { Transaction } from '../../config/database.js';

export interface PushDevice {
  id: string;
  platform: 'ios' | 'android';
  token: string;
  locale: 'bn' | 'en';
}

/** Phones that can be sent a push, and the inbox lines still to be pushed. */
export class PushRepository {
  /** A token seen again moves to whoever signed in with it last, so a shared phone follows its user. */
  async register(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    device: { platform: 'ios' | 'android'; token: string; locale: 'bn' | 'en' },
  ) {
    await tx.query(
      `INSERT INTO matrimony.push_devices (agency_id, account_id, platform, token, locale)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agency_id, token) DO UPDATE
         SET account_id = EXCLUDED.account_id, platform = EXCLUDED.platform,
             locale = EXCLUDED.locale, last_seen_at = now()`,
      [agencyId, accountId, device.platform, device.token, device.locale],
    );
  }
  async unregister(tx: Transaction, agencyId: string, accountId: string, token: string) {
    await tx.query(
      'DELETE FROM matrimony.push_devices WHERE agency_id = $1 AND account_id = $2 AND token = $3',
      [agencyId, accountId, token],
    );
  }
  async forget(tx: Transaction, agencyId: string, deviceId: string) {
    await tx.query('DELETE FROM matrimony.push_devices WHERE agency_id = $1 AND id = $2', [
      agencyId,
      deviceId,
    ]);
  }
  async devices(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT id, platform, token, locale FROM matrimony.push_devices
        WHERE agency_id = $1 AND account_id = $2`,
      [agencyId, accountId],
    );
    return result.rows as PushDevice[];
  }
  /**
   * Takes the lines that have not been pushed yet, in one statement, so two API processes never send
   * the same line. Lines older than a day are marked handled and not sent (a phone that was off).
   */
  async claim(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `UPDATE matrimony.notifications
          SET pushed_at = now()
        WHERE agency_id = $1 AND recipient_account_id = $2 AND pushed_at IS NULL
        RETURNING template_key, created_at > now() - interval '1 day' AS fresh`,
      [agencyId, accountId],
    );
    return (result.rows as { template_key: string; fresh: boolean }[])
      .filter((row) => row.fresh)
      .map((row) => row.template_key);
  }
}
