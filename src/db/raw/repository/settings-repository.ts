import { parseSettings, type AgencySettings } from '../../../bo/agency-settings.js';
import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

/** The agency's own settings, stored as one JSON value on the agency. */
export class SettingsRepository {
  /** The settings, locked when they are about to change. Missing or invalid values read as the defaults. */
  async get(tx: Transaction, agencyId: string, lock = false): Promise<AgencySettings> {
    const result = await tx.query(
      `SELECT settings FROM matrimony.agencies WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [agencyId],
    );
    return parseSettings((result.rows[0] as Row | undefined)?.settings);
  }

  async save(tx: Transaction, agencyId: string, settings: AgencySettings): Promise<void> {
    await tx.query(
      `UPDATE matrimony.agencies SET settings = $2::jsonb, updated_at = now() WHERE id = $1`,
      [agencyId, JSON.stringify(settings)],
    );
  }
}
