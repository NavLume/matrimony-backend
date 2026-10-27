import type { Transaction } from '../../config/database.js';
import type { Lead, ShowcaseCandidate } from '../../../bo/showcase.js';

type Row = Record<string, unknown>;

/** A published photo exists for the profile. */
const HAS_PHOTO = `EXISTS (SELECT 1 FROM matrimony.profile_photos ph
   WHERE ph.agency_id = m.agency_id AND ph.profile_id = m.id AND ph.status = 'published')`;

const candidate = (row: Row): ShowcaseCandidate => ({
  profileId: row.profile_id as string,
  memberCode: row.member_code as string,
  fullName: row.full_name as string,
  professionCode: (row.profession_code as string | null) ?? null,
  districtCode: (row.current_district_code as string | null) ?? null,
  status: row.status as string,
  hidden: row.website_hidden === true,
  hasPhoto: row.has_photo === true,
});

/** The showcase of blurred cards, and the leads a visitor leaves from it. */
export class ShowcaseRepository {
  /** The agency's public config without a lock (the public site reads it on every visit). */
  async publicConfig(tx: Transaction, agencyId: string): Promise<unknown> {
    const result = await tx.query(`SELECT public_config FROM matrimony.agencies WHERE id = $1`, [
      agencyId,
    ]);
    return (result.rows[0] as Row | undefined)?.public_config;
  }

  /** The cards to show: published profiles that are not switched off and have a photo, newest added first. */
  async cards(tx: Transaction, agencyId: string, limit: number) {
    const result = await tx.query(
      `SELECT s.public_ref AS ref, to_char(m.date_of_birth, 'YYYY-MM-DD') AS dob,
              m.profession_code, m.current_district_code, m.religion_code, m.country_code,
              p.age_min, p.age_max, p.education_min_code, p.profession_codes, p.district_codes,
              p.religious_practice_codes
         FROM matrimony.website_showcase s
         JOIN matrimony.member_profiles m ON m.agency_id = s.agency_id AND m.id = s.profile_id
         LEFT JOIN matrimony.partner_preferences p ON p.agency_id = m.agency_id AND p.profile_id = m.id
        WHERE s.agency_id = $1 AND m.status = 'active' AND m.website_hidden = false AND ${HAS_PHOTO}
        ORDER BY s.added_at DESC, s.public_ref
        LIMIT $2`,
      [agencyId, limit],
    );
    return result.rows as Row[];
  }

  /**
   * Every showable card that matches the visitor's filters, a page at a time, with the total. A filter left out
   * matches everyone; a person with no country counts as living in Bangladesh.
   */
  async browse(
    tx: Transaction,
    agencyId: string,
    filter: {
      district: string | null;
      religion: string | null;
      profession: string | null;
      country: string | null;
      ageMin: number | null;
      ageMax: number | null;
    },
    limit: number,
    offset: number,
  ) {
    const result = await tx.query(
      `SELECT s.public_ref AS ref, to_char(m.date_of_birth, 'YYYY-MM-DD') AS dob,
              m.profession_code, m.current_district_code, m.religion_code, m.country_code,
              p.age_min, p.age_max, p.education_min_code, p.profession_codes, p.district_codes,
              p.religious_practice_codes, count(*) OVER () AS total
         FROM matrimony.website_showcase s
         JOIN matrimony.member_profiles m ON m.agency_id = s.agency_id AND m.id = s.profile_id
         LEFT JOIN matrimony.partner_preferences p ON p.agency_id = m.agency_id AND p.profile_id = m.id
        WHERE s.agency_id = $1 AND m.status = 'active' AND m.website_hidden = false AND ${HAS_PHOTO}
          AND ($2::text IS NULL OR m.current_district_code = $2::text)
          AND ($3::text IS NULL OR m.religion_code = $3::text)
          AND ($4::text IS NULL OR m.profession_code = $4::text)
          AND ($5::text IS NULL OR coalesce(m.country_code, 'bangladesh') = $5::text)
          AND ($6::int IS NULL OR date_part('year', age(m.date_of_birth)) >= $6::int)
          AND ($7::int IS NULL OR date_part('year', age(m.date_of_birth)) <= $7::int)
        ORDER BY s.added_at DESC, s.public_ref
        LIMIT $8 OFFSET $9`,
      [
        agencyId,
        filter.district,
        filter.religion,
        filter.profession,
        filter.country,
        filter.ageMin,
        filter.ageMax,
        limit,
        offset,
      ],
    );
    return result.rows as Row[];
  }

  /** The member code behind a card that can be shown now, for a member's request to their agent. */
  async codeOfRef(tx: Transaction, agencyId: string, ref: string): Promise<string | null> {
    const result = await tx.query(
      `SELECT m.member_code FROM matrimony.website_showcase s
         JOIN matrimony.member_profiles m ON m.agency_id = s.agency_id AND m.id = s.profile_id
        WHERE s.agency_id = $1 AND s.public_ref = $2 AND m.status = 'active' AND m.website_hidden = false`,
      [agencyId, ref],
    );
    return ((result.rows[0] as Row | undefined)?.member_code as string | undefined) ?? null;
  }

  /**
   * A reminder on the agent's agenda saying a client liked a card on the website. The same request is not added twice
   * while the first is still open. Returns false when it was already there.
   */
  async addIntroductionRequest(
    tx: Transaction,
    agencyId: string,
    request: { id: string; profileId: string; assignedTo: string; createdBy: string; text: string },
  ): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO matrimony.client_follow_ups (agency_id, id, profile_id, due_on, text, assigned_to, created_by)
       SELECT $1, $2, $3, (now() AT TIME ZONE 'Asia/Dhaka')::date, $4, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM matrimony.client_follow_ups f
                           WHERE f.agency_id = $1 AND f.profile_id = $3 AND f.text = $4 AND f.done_at IS NULL)`,
      [
        agencyId,
        request.id,
        request.profileId,
        request.text,
        request.assignedTo,
        request.createdBy,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The stored photo of a card's profile (its main published one), or null when the card is not showable. */
  async photoKey(tx: Transaction, agencyId: string, ref: string): Promise<string | null> {
    const result = await tx.query(
      `SELECT (SELECT ph.storage_key FROM matrimony.profile_photos ph
                WHERE ph.agency_id = m.agency_id AND ph.profile_id = m.id AND ph.status = 'published'
                ORDER BY ph.is_primary DESC, ph.sort_order, ph.created_at LIMIT 1) AS storage_key
         FROM matrimony.website_showcase s
         JOIN matrimony.member_profiles m ON m.agency_id = s.agency_id AND m.id = s.profile_id
        WHERE s.agency_id = $1 AND s.public_ref = $2 AND m.status = 'active' AND m.website_hidden = false`,
      [agencyId, ref],
    );
    return ((result.rows[0] as Row | undefined)?.storage_key as string | null | undefined) ?? null;
  }

  /** The profile behind a card, for a lead. Null when the card is not showable now. */
  async profileOfRef(tx: Transaction, agencyId: string, ref: string): Promise<string | null> {
    const result = await tx.query(
      `SELECT s.profile_id FROM matrimony.website_showcase s
         JOIN matrimony.member_profiles m ON m.agency_id = s.agency_id AND m.id = s.profile_id
        WHERE s.agency_id = $1 AND s.public_ref = $2 AND m.status = 'active' AND m.website_hidden = false`,
      [agencyId, ref],
    );
    return ((result.rows[0] as Row | undefined)?.profile_id as string | undefined) ?? null;
  }

  /** The profiles in the showcase, newest first (including ones that are switched off, so the admin can see why). */
  async entries(tx: Transaction, agencyId: string): Promise<ShowcaseCandidate[]> {
    const result = await tx.query(
      `SELECT m.id AS profile_id, m.member_code, m.full_name, m.profession_code, m.current_district_code,
              m.status, m.website_hidden, ${HAS_PHOTO} AS has_photo
         FROM matrimony.website_showcase s
         JOIN matrimony.member_profiles m ON m.agency_id = s.agency_id AND m.id = s.profile_id
        WHERE s.agency_id = $1
        ORDER BY s.added_at DESC`,
      [agencyId],
    );
    return (result.rows as Row[]).map(candidate);
  }

  /** Published profiles with a photo that are not in the showcase yet and have not been switched off. */
  async eligible(tx: Transaction, agencyId: string, limit: number): Promise<ShowcaseCandidate[]> {
    const result = await tx.query(
      `SELECT m.id AS profile_id, m.member_code, m.full_name, m.profession_code, m.current_district_code,
              m.status, m.website_hidden, ${HAS_PHOTO} AS has_photo
         FROM matrimony.member_profiles m
        WHERE m.agency_id = $1 AND m.status = 'active' AND m.website_hidden = false AND ${HAS_PHOTO}
          AND NOT EXISTS (SELECT 1 FROM matrimony.website_showcase s
                           WHERE s.agency_id = m.agency_id AND s.profile_id = m.id)
        ORDER BY m.full_name
        LIMIT $2`,
      [agencyId, limit],
    );
    return (result.rows as Row[]).map(candidate);
  }

  /** What is needed to decide whether a profile may be added. */
  async profileForShowcase(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT m.status, m.website_hidden, ${HAS_PHOTO} AS has_photo
         FROM matrimony.member_profiles m WHERE m.agency_id = $1 AND m.id = $2`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          status: row.status as string,
          hidden: row.website_hidden === true,
          hasPhoto: row.has_photo === true,
        }
      : null;
  }

  async add(tx: Transaction, agencyId: string, profileId: string, by: string): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO matrimony.website_showcase (agency_id, profile_id, added_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [agencyId, profileId, by],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async remove(tx: Transaction, agencyId: string, profileId: string): Promise<boolean> {
    const result = await tx.query(
      `DELETE FROM matrimony.website_showcase WHERE agency_id = $1 AND profile_id = $2`,
      [agencyId, profileId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** A profile as the "show on the website" switch sees it: who owns it, who looks after it, and whether it is hidden. */
  async switchTarget(
    tx: Transaction,
    agencyId: string,
    by: { own: string } | { profileId: string },
  ) {
    const result =
      'own' in by
        ? await tx.query(
            `SELECT id, assigned_agent_id, website_hidden FROM matrimony.member_profiles
              WHERE agency_id = $1 AND owner_account_id = $2 FOR UPDATE`,
            [agencyId, by.own],
          )
        : await tx.query(
            `SELECT id, assigned_agent_id, website_hidden FROM matrimony.member_profiles
              WHERE agency_id = $1 AND id = $2 FOR UPDATE`,
            [agencyId, by.profileId],
          );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          id: row.id as string,
          assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
          hidden: row.website_hidden === true,
        }
      : null;
  }

  async setHidden(tx: Transaction, agencyId: string, profileId: string, hidden: boolean) {
    await tx.query(
      `UPDATE matrimony.member_profiles SET website_hidden = $3 WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId, hidden],
    );
  }

  // ---- leads ------------------------------------------------------------------------------------

  async insertLead(
    tx: Transaction,
    agencyId: string,
    lead: { name: string; phone: string; profileId: string | null },
  ) {
    await tx.query(
      `INSERT INTO matrimony.website_leads (agency_id, profile_id, name, phone_e164)
       VALUES ($1, $2, $3, $4)`,
      [agencyId, lead.profileId, lead.name, lead.phone],
    );
  }

  async leads(
    tx: Transaction,
    agencyId: string,
    status: string | null,
    limit: number,
  ): Promise<Lead[]> {
    const result = await tx.query(
      `SELECT l.id, l.name, l.phone_e164, l.status, l.note, l.created_at, l.profile_id,
              m.member_code, m.profession_code
         FROM matrimony.website_leads l
         LEFT JOIN matrimony.member_profiles m ON m.agency_id = l.agency_id AND m.id = l.profile_id
        WHERE l.agency_id = $1 AND ($2::text IS NULL OR l.status = $2::text)
        ORDER BY (l.status = 'new') DESC, l.created_at DESC, l.id
        LIMIT $3`,
      [agencyId, status, limit],
    );
    return (result.rows as Row[]).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      phone: row.phone_e164 as string,
      status: row.status as Lead['status'],
      note: (row.note as string | null) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      about: row.profile_id
        ? {
            profileId: row.profile_id as string,
            memberCode: row.member_code as string,
            professionCode: (row.profession_code as string | null) ?? null,
          }
        : null,
    }));
  }

  async newLeadCount(tx: Transaction, agencyId: string): Promise<number> {
    const result = await tx.query(
      `SELECT count(*)::int AS n FROM matrimony.website_leads WHERE agency_id = $1 AND status = 'new'`,
      [agencyId],
    );
    return (result.rows[0] as Row).n as number;
  }

  async updateLead(
    tx: Transaction,
    agencyId: string,
    id: string,
    change: { status: string; note: string | null; by: string },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE matrimony.website_leads
          SET status = $3, note = $4, handled_by = $5, handled_at = now()
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, change.status, change.note, change.by],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
