import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

export interface PublishedStory {
  names: unknown;
  story: unknown;
  year: number | null;
}

/** The agency's public content, and the success stories its admin published. */
export class SiteContentRepository {
  async config(tx: Transaction, agencyId: string): Promise<Record<string, unknown>> {
    const result = await tx.query(
      `SELECT public_config FROM matrimony.agencies WHERE id = $1 FOR UPDATE`,
      [agencyId],
    );
    const value = (result.rows[0] as Row | undefined)?.public_config;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  async agencyName(tx: Transaction, agencyId: string): Promise<string> {
    const result = await tx.query(`SELECT name FROM matrimony.agencies WHERE id = $1`, [agencyId]);
    return ((result.rows[0] as Row | undefined)?.name as string | undefined) ?? '';
  }

  async saveConfig(tx: Transaction, agencyId: string, config: Record<string, unknown>) {
    await tx.query(
      `UPDATE matrimony.agencies SET public_config = $2::jsonb, updated_at = now() WHERE id = $1`,
      [agencyId, JSON.stringify(config)],
    );
  }

  async publishedStories(
    tx: Transaction,
    agencyId: string,
    limit: number,
  ): Promise<PublishedStory[]> {
    const result = await tx.query(
      `SELECT names, story, story_year FROM matrimony.success_stories
        WHERE agency_id = $1 AND status = 'published'
        ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $2`,
      [agencyId, limit],
    );
    return (result.rows as Row[]).map((row) => ({
      names: row.names,
      story: row.story,
      year: (row.story_year as number | null) ?? null,
    }));
  }

  async publishedCount(tx: Transaction, agencyId: string): Promise<number> {
    const result = await tx.query(
      `SELECT count(*)::int AS n FROM matrimony.success_stories WHERE agency_id = $1 AND status = 'published'`,
      [agencyId],
    );
    return (result.rows[0] as Row).n as number;
  }
}
