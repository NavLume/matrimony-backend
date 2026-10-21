import { EDUCATION_LEVELS, FAMILY_STATUSES, INCOME_BANDS } from '../../../bo/dictionaries.js';
import type {
  ConnectionLink,
  MatchFilters,
  MatchItem,
  SharedContact,
} from '../../../bo/matches.js';
import { ageOn } from '../../../bo/profile.js';
import type { Cursor } from '../../../bo/review.js';
import type { VisibleField } from '../../../bo/release.js';
import type { Transaction } from '../../config/database.js';
import type { ConnectionBox, ConnectionRow } from '../../../bo/connection.js';
import { connectionQueries } from '../query/connection.js';
import { matchQueries } from '../query/match.js';

type Row = Record<string, unknown>;

/** The profiles a member may look at, read with only the columns they are allowed to see. */
export class MatchRepository {
  async ownProfile(
    tx: Transaction,
    agencyId: string,
    accountId: string,
  ): Promise<{ id: string; status: string } | null> {
    const result = await tx.query(matchQueries.ownProfile, [agencyId, accountId]);
    return (result.rows[0] as { id: string; status: string } | undefined) ?? null;
  }

  /** The profile a guardian account looks after, while the guardian link is active. */
  async guardedProfile(
    tx: Transaction,
    agencyId: string,
    accountId: string,
  ): Promise<{ id: string; status: string } | null> {
    const result = await tx.query(matchQueries.guardedProfile, [agencyId, accountId]);
    return (result.rows[0] as { id: string; status: string } | undefined) ?? null;
  }

  async releasedTotal(tx: Transaction, agencyId: string, clientId: string): Promise<number> {
    const result = await tx.query(matchQueries.releasedTotal, [agencyId, clientId]);
    return (result.rows[0] as { n: number }).n;
  }

  /** One page, newest release first. Asks for one more than `limit` so the caller can tell if there is a next page. */
  async page(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    visible: readonly VisibleField[],
    filters: MatchFilters,
    page: { limit: number; after: Cursor | null },
    today: Date,
  ): Promise<MatchItem[]> {
    const from = (list: readonly string[], low: string | undefined, high?: string) => {
      if (low === undefined && high === undefined) return null;
      const start = low === undefined ? 0 : list.indexOf(low);
      const end = high === undefined ? list.length : list.indexOf(high) + 1;
      return list.slice(start, end);
    };
    const education = filters.educationMin
      ? EDUCATION_LEVELS.slice(EDUCATION_LEVELS.indexOf(filters.educationMin))
      : null;
    const result = await tx.query(matchQueries.page(visible), [
      agencyId,
      clientId,
      filters.q ?? null,
      filters.ageMin ?? null,
      filters.ageMax ?? null,
      filters.religion ?? null,
      filters.maritalStatus ?? null,
      filters.profession ?? null,
      filters.district ?? null,
      education ? [...education] : null,
      page.after?.createdAt ?? null,
      page.after?.id ?? null,
      page.limit + 1,
      filters.heightMin ?? null,
      filters.heightMax ?? null,
      from(INCOME_BANDS, filters.incomeMin, filters.incomeMax),
      from(FAMILY_STATUSES, filters.familyStatusMin),
      filters.originDistrict ?? null,
    ]);
    return result.rows.map((row) => this.item(row as Row, visible, today).item);
  }

  /** One page of a client's connections in a box, each with the other person as the client may see them. */
  async connections(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    box: ConnectionBox,
    visible: readonly VisibleField[],
    page: { limit: number; after: Cursor | null },
    today: Date,
  ): Promise<ConnectionRow[]> {
    const result = await tx.query(connectionQueries.list(visible), [
      agencyId,
      clientId,
      box,
      page.after?.createdAt ?? null,
      page.after?.id ?? null,
      page.limit + 1,
    ]);
    return result.rows.map((raw) => {
      const row = raw as Row;
      const { item, link } = this.item(row, visible, today);
      return {
        connectionId: row.connection_id as string,
        status: link!.status,
        direction: link!.direction,
        createdAt: (row.created_at as Date).toISOString(),
        respondedAt: row.responded_at ? (row.responded_at as Date).toISOString() : null,
        iShared: link!.iShared,
        theyShared: link!.theyShared,
        note: (row.note as string | null) ?? null,
        position: row.position as string,
        guardianAdvice: row.advice
          ? {
              advice: row.advice as 'supportive' | 'concerned',
              note: (row.advice_note as string | null) ?? null,
              at: (row.advice_at as Date).toISOString(),
            }
          : null,
        profile: item,
      };
    });
  }

  /** One profile the client may look at, with every field they are allowed, or null when they may not. */
  async person(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    candidateId: string,
    visible: readonly VisibleField[],
    today: Date,
  ): Promise<{ item: MatchItem; link: ConnectionLink | null } | null> {
    const result = await tx.query(matchQueries.person(visible), [agencyId, clientId, candidateId]);
    const row = result.rows[0] as Row | undefined;
    return row ? this.item(row, visible, today) : null;
  }

  /** Whether the client may look at this profile at all (the same rule as `person`). */
  async viewable(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    candidateId: string,
  ): Promise<boolean> {
    const result = await tx.query(matchQueries.viewable, [agencyId, clientId, candidateId]);
    return result.rows.length > 0;
  }

  /** What the other person shared with the client, if they did and the connection is accepted. */
  async sharedContact(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    otherId: string,
  ): Promise<SharedContact | null> {
    const result = await tx.query(matchQueries.sharedContact, [agencyId, clientId, otherId]);
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          name: row.contact_name as string | null,
          relationship: row.contact_relationship as string | null,
          phone: row.phone_e164 as string | null,
          email: row.email as string | null,
        }
      : null;
  }

  /** The storage key of a profile's photo, or null when there is none or the client may not look at it. */
  /**
   * The photo another member may look at: where it is, whether it must be blurred (the owner chose that and no
   * proposal between the two is accepted), and the viewer's member code for the watermark.
   */
  async viewablePhoto(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    candidateId: string,
  ): Promise<{ storageKey: string; blurred: boolean; viewerCode: string } | null> {
    if (!(await this.viewable(tx, agencyId, clientId, candidateId))) return null;
    const photo = await tx.query(matchQueries.photo, [agencyId, candidateId]);
    const storageKey = (photo.rows[0] as { storage_key: string } | undefined)?.storage_key;
    if (!storageKey) return null;
    const rule = await tx.query(
      `SELECT c.photo_privacy, v.member_code AS viewer_code,
              EXISTS (SELECT 1 FROM matrimony.interests x
                       WHERE x.agency_id = c.agency_id AND x.status = 'accepted'
                         AND ((x.sender_profile_id = $2 AND x.recipient_profile_id = $3)
                           OR (x.sender_profile_id = $3 AND x.recipient_profile_id = $2))) AS connected
         FROM matrimony.member_profiles c
         JOIN matrimony.member_profiles v ON v.agency_id = c.agency_id AND v.id = $2
        WHERE c.agency_id = $1 AND c.id = $3`,
      [agencyId, clientId, candidateId],
    );
    const row = rule.rows[0] as
      { photo_privacy: string; viewer_code: string; connected: boolean } | undefined;
    if (!row) return null;
    return {
      storageKey,
      blurred: row.photo_privacy === 'blurred' && !row.connected,
      viewerCode: row.viewer_code,
    };
  }

  /** Builds the item from the row, copying only the fields that were allowed and selected. */
  private item(
    row: Row,
    visible: readonly VisibleField[],
    today: Date,
  ): { item: MatchItem; link: ConnectionLink | null } {
    const sent = row.connection_sent === true;
    const link: ConnectionLink | null = row.connection_id
      ? {
          id: row.connection_id as string,
          status: row.connection_status as ConnectionLink['status'],
          direction: sent ? 'sent' : 'received',
          iShared: (sent ? row.from_shared : row.to_shared) === true,
          theyShared: (sent ? row.to_shared : row.from_shared) === true,
        }
      : null;
    const item: MatchItem = {
      candidateId: row.id as string,
      memberCode: row.member_code as string,
      position: (row.position as string | undefined) ?? '',
      verified: row.verified === true,
      verifiedChecks: (row.verified_checks as string[] | null) ?? [],
      connection: link && { id: link.id, status: link.status, direction: link.direction },
    };
    const has = (field: VisibleField) => visible.includes(field);
    if (has('fullName')) item.fullName = row.full_name as string;
    if (has('age')) {
      const born = row.date_of_birth as string | null;
      item.age = born ? ageOn(born, today) : null;
    }
    if (has('photo')) {
      item.hasPhoto = row.has_photo === true;
      // The picture is sent blurred until a proposal between the two is accepted.
      item.photoBlurred = row.photo_blurred === true;
    }
    if (has('aboutMe')) item.aboutMe = row.about_me as string | null;
    if (has('professionCode')) item.professionCode = row.profession_code as string | null;
    if (has('occupationCode')) item.occupationCode = row.occupation_code as string | null;
    if (has('highestDegreeCode')) item.highestDegreeCode = row.highest_degree_code as string | null;
    if (has('heightCm')) item.heightCm = row.height_cm as number | null;
    if (has('maritalStatus')) item.maritalStatus = row.marital_status as string | null;
    if (has('religionCode')) item.religionCode = row.religion_code as string | null;
    if (has('currentDistrictCode'))
      item.currentDistrictCode = row.current_district_code as string | null;
    if (has('originDistrictCode'))
      item.originDistrictCode = row.origin_district_code as string | null;
    if (has('monthlyIncomeBandCode'))
      item.monthlyIncomeBandCode = row.monthly_income_band_code as string | null;
    if (has('familyStatusCode')) item.familyStatusCode = row.family_status_code as string | null;
    if (has('hobbies')) item.hobbies = row.hobbies as string | null;
    return { item, link };
  }
}
