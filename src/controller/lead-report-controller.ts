import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  leadFunnelQuerySchema,
  revenueShareQuerySchema,
  visitInputSchema,
} from '../bo/lead-report.js';
import { AppError } from '../exception/app-error.js';
import type { LeadReportService } from '../service/lead-report-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };

/** The lead funnel and the monthly revenue share (admin), and the public visit counter (bo/lead-report.ts). */
export function registerLeadReportController(
  app: FastifyInstance,
  reports: Pick<LeadReportService, 'recordVisit' | 'funnel' | 'revenueShare'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const ownHost = (req: FastifyRequest) => {
    try {
      return new URL(req.canonicalOrigin).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  };

  // One arrival on the public site, counted by source only. Same-origin, and limited per address.
  app.post(
    '/api/v1/public/visits',
    { config: { public: true, rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req, reply) => {
      if (req.headers.origin !== req.canonicalOrigin) throw new AppError(403, 'ORIGIN_INVALID');
      await reports.recordVisit(
        req.tenant!.id,
        visitInputSchema.parse(req.body ?? {}).origin,
        ownHost(req),
      );
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/admin/reports/leads', { config: adminOnly }, async (req) =>
    reports.funnel(actor(req), leadFunnelQuerySchema.parse(req.query)),
  );

  app.get('/api/v1/admin/reports/revenue-share', { config: adminOnly }, async (req) =>
    reports.revenueShare(actor(req), revenueShareQuerySchema.parse(req.query)),
  );
}
