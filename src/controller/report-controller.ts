import type { FastifyInstance } from 'fastify';
import { networkQuerySchema, proposalListQuerySchema, summaryQuerySchema } from '../bo/report.js';
import type { ReportService } from '../service/report-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };

/** The admin's reports (see bo/report.ts). Read only. */
export function registerReportController(
  app: FastifyInstance,
  reports: Pick<ReportService, 'summary' | 'proposals' | 'network'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  // The summary reads a lot of rows at once, so it is limited more tightly than other reads.
  const heavy = { ...adminOnly, rateLimit: { max: 30, timeWindow: 60000 } };

  app.get('/api/v1/admin/reports/summary', { config: heavy }, async (req) =>
    reports.summary(actor(req), summaryQuerySchema.parse(req.query)),
  );
  app.get('/api/v1/admin/reports/proposals', { config: adminOnly }, async (req) =>
    reports.proposals(actor(req), proposalListQuerySchema.parse(req.query)),
  );
  app.get('/api/v1/admin/reports/network', { config: heavy }, async (req) =>
    reports.network(actor(req), networkQuerySchema.parse(req.query).client ?? null),
  );
}
