import type { Transaction } from '../../config/database.js';

type Row = Record<string, unknown>;

export interface PublishedStory {
  names: unknown;
  story: unknown;
  year: number | null;
  photoFile: string | null;
  weddingDate: string | null;
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
      `SELECT names, story, story_year, photo_file, to_char(wedding_date, 'YYYY-MM-DD') AS wedding_date
         FROM matrimony.success_stories
        WHERE agency_id = $1 AND status = 'published'
        ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $2`,
      [agencyId, limit],
    );
    return (result.rows as Row[]).map((row) => ({
      names: row.names,
      story: row.story,
      year: (row.story_year as number | null) ?? null,
      photoFile: (row.photo_file as string | null) ?? null,
      weddingDate: (row.wedding_date as string | null) ?? null,
    }));
  }

  /**
   * Sets or clears a story's photo and wedding date. Returns the photo it replaced (to delete), or undefined when
   * there is no such story or it was removed. A story that was removed can never get a face back.
   */
  async setStoryDetails(
    tx: Transaction,
    agencyId: string,
    storyId: string,
    change: { photoFile?: string | null; weddingDate?: string | null },
  ): Promise<{ previous: string | null } | undefined> {
    const found = await tx.query(
      `SELECT photo_file FROM matrimony.success_stories
        WHERE agency_id = $1 AND id = $2 AND removed_at IS NULL FOR UPDATE`,
      [agencyId, storyId],
    );
    const row = found.rows[0] as Row | undefined;
    if (!row) return undefined;
    await tx.query(
      `UPDATE matrimony.success_stories
          SET photo_file = CASE WHEN $3::boolean THEN $4::text ELSE photo_file END,
              wedding_date = CASE WHEN $5::boolean THEN $6::date ELSE wedding_date END,
              updated_at = now()
        WHERE agency_id = $1 AND id = $2`,
      [
        agencyId,
        storyId,
        change.photoFile !== undefined,
        change.photoFile ?? null,
        change.weddingDate !== undefined,
        change.weddingDate ?? null,
      ],
    );
    return { previous: (row.photo_file as string | null) ?? null };
  }

  async storyPhotoFile(tx: Transaction, agencyId: string, storyId: string): Promise<string | null> {
    const result = await tx.query(
      `SELECT photo_file FROM matrimony.success_stories
        WHERE agency_id = $1 AND id = $2 AND removed_at IS NULL`,
      [agencyId, storyId],
    );
    return ((result.rows[0] as Row | undefined)?.photo_file as string | null | undefined) ?? null;
  }

  /** Whether a story photo belongs to a story that is published now (only then is it served). */
  async isPublishedPhoto(tx: Transaction, agencyId: string, file: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM matrimony.success_stories
        WHERE agency_id = $1 AND photo_file = $2 AND status = 'published' AND removed_at IS NULL`,
      [agencyId, file],
    );
    return result.rows.length > 0;
  }

  async publishedCount(tx: Transaction, agencyId: string): Promise<number> {
    const result = await tx.query(
      `SELECT count(*)::int AS n FROM matrimony.success_stories WHERE agency_id = $1 AND status = 'published'`,
      [agencyId],
    );
    return (result.rows[0] as Row).n as number;
  }
}
