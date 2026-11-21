import type { Transaction } from '../../config/database.js';
import {
  linkPath,
  type CampaignLink,
  type CampaignLinkInput,
  type LinkKind,
} from '../../../bo/campaign-link.js';

type Row = Record<string, unknown>;

const SELECT = `SELECT c.id, c.kind, c.name, c.slug, c.office, c.locale, c.created_by, c.created_at, c.archived_at,
       a.display_name AS created_by_name,
       (SELECT count(*)::int FROM matrimony.website_leads l
         WHERE l.agency_id = c.agency_id AND l.utm_campaign = c.slug) AS leads,
       (SELECT count(*)::int FROM matrimony.website_leads l
         WHERE l.agency_id = c.agency_id AND l.utm_campaign = c.slug AND l.verified_at IS NOT NULL) AS verified
  FROM matrimony.campaign_links c
  LEFT JOIN matrimony.accounts a ON a.agency_id = c.agency_id AND a.id = c.created_by`;

const toLink = (row: Row): CampaignLink => {
  const base = {
    kind: row.kind as LinkKind,
    slug: row.slug as string,
    office: (row.office as number | null) ?? null,
    locale: row.locale as 'bn' | 'en',
  };
  return {
    id: row.id as string,
    ...base,
    name: row.name as string,
    path: linkPath(base),
    createdBy: { id: row.created_by as string, name: (row.created_by_name as string | null) ?? '' },
    createdAt: (row.created_at as Date).toISOString(),
    archivedAt: row.archived_at instanceof Date ? row.archived_at.toISOString() : null,
    leads: row.leads as number,
    verified: row.verified as number,
  };
};

/** Staff-made tagged links and the enquiries each one brought. */
export class CampaignLinkRepository {
  async list(tx: Transaction, agencyId: string, archived: boolean): Promise<CampaignLink[]> {
    const result = await tx.query(
      `${SELECT}
        WHERE c.agency_id = $1 AND (c.archived_at IS NOT NULL) = $2
        ORDER BY c.created_at DESC, c.id
        LIMIT 500`,
      [agencyId, archived],
    );
    return (result.rows as Row[]).map(toLink);
  }

  async one(tx: Transaction, agencyId: string, id: string): Promise<CampaignLink | null> {
    const result = await tx.query(`${SELECT} WHERE c.agency_id = $1 AND c.id = $2`, [agencyId, id]);
    const row = result.rows[0] as Row | undefined;
    return row ? toLink(row) : null;
  }

  /** Stores a link; null when the campaign name is taken (the caller tries another). */
  async insert(
    tx: Transaction,
    agencyId: string,
    link: CampaignLinkInput & { slug: string; createdBy: string },
  ): Promise<string | null> {
    const result = await tx.query(
      `INSERT INTO matrimony.campaign_links (agency_id, kind, name, slug, office, locale, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (agency_id, slug) DO NOTHING
       RETURNING id`,
      [agencyId, link.kind, link.name, link.slug, link.office ?? null, link.locale, link.createdBy],
    );
    return ((result.rows[0] as Row | undefined)?.id as string | undefined) ?? null;
  }

  async setArchived(tx: Transaction, agencyId: string, id: string, archived: boolean) {
    await tx.query(
      `UPDATE matrimony.campaign_links
          SET archived_at = CASE WHEN $3 THEN coalesce(archived_at, now()) END
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, archived],
    );
  }
}
