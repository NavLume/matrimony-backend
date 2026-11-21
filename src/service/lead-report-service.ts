import { parseSettings } from '../bo/agency-settings.js';
import { originSchema, sourceOf } from '../bo/consultation.js';
import {
  bySourceOf,
  emptyCounts,
  PLATFORM_SHARE_PERCENT,
  splitShare,
  type LeadFunnel,
  type RevenueShare,
} from '../bo/lead-report.js';
import type { LeadReportDbService } from '../db/service/lead-report-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

const DAY_MS = 86_400_000;
const BD_OFFSET_MS = 6 * 3_600_000;
const CAMPAIGNS = 30;

/** A Bangladesh calendar day (YYYY-MM-DD) of an instant. */
const bdDay = (at: Date) => new Date(at.getTime() + BD_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The lead reports for the agency's admin (see bo/lead-report.ts), and the visit counter the public site reports to.
 */
export class LeadReportService {
  constructor(
    private readonly db: Pick<LeadReportDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Counts one arrival on the public site by its source and campaign (nothing about the person). A broken origin is
   * read as a direct visit, never refused.
   */
  async recordVisit(agencyId: string, rawOrigin: unknown, ownHost: string | null): Promise<void> {
    const origin = originSchema.parse(rawOrigin);
    await this.db.inTransaction(agencyId, async (unit) => {
      const { oldSiteHosts } = parseSettings(await unit.settings(agencyId)).leads;
      await unit.addVisit(
        agencyId,
        bdDay(this.now()),
        sourceOf(origin, ownHost, oldSiteHosts),
        origin?.utmCampaign ?? '',
      );
    });
  }

  /** The funnel by source and by campaign for enquiries made from `from` to `to` (default: the last 30 days). */
  async funnel(actor: ProfileActor, query: { from?: string; to?: string }): Promise<LeadFunnel> {
    this.adminOnly(actor);
    const to = query.to ?? bdDay(this.now());
    const from = query.from ?? bdDay(new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * DAY_MS));
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const [visits, sources, campaigns] = [
        await unit.visits(actor.agencyId, from, to),
        await unit.bySource(actor.agencyId, from, to),
        await unit.byCampaign(actor.agencyId, from, to, CAMPAIGNS),
      ];
      const { bySource, total } = bySourceOf([
        ...sources,
        ...visits.map((v) => ({ source: v.source, visits: v.visits })),
      ]);
      const campaignVisits = new Map<string, number>();
      for (const v of visits)
        if (v.campaign)
          campaignVisits.set(v.campaign, (campaignVisits.get(v.campaign) ?? 0) + v.visits);
      const byCampaign = campaigns.map((row) => ({
        ...emptyCounts(),
        ...row,
        visits: campaignVisits.get(row.campaign) ?? 0,
      }));
      return { from, to, total, bySource, byCampaign };
    });
  }

  /** The payments of one month (default: this month) counted for the revenue share, and the share. */
  async revenueShare(actor: ProfileActor, query: { month?: string }): Promise<RevenueShare> {
    this.adminOnly(actor);
    const month = query.month ?? bdDay(this.now()).slice(0, 7);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const payments = await unit.sharedPayments(actor.agencyId, `${month}-01`);
      const total = payments.reduce((sum, p) => sum + p.amount, 0);
      const { share, agency } = splitShare(total);
      return {
        month,
        percent: PLATFORM_SHARE_PERCENT,
        payments,
        total,
        share,
        agency,
        clientBeforeLeadTotal: payments
          .filter((p) => p.clientBeforeLead)
          .reduce((sum, p) => sum + p.amount, 0),
      };
    });
  }

  private adminOnly(actor: ProfileActor) {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}
