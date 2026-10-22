import type { FastifyInstance } from 'fastify';
import { funnelQuerySchema } from '../bo/funnel.js';
import type { FunnelService } from '../service/funnel-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

/** The full funnel, for staff (see bo/funnel.ts). An agent reads their own clients' only. */
export function registerFunnelController(
  app: FastifyInstance,
  funnel: Pick<FunnelService, 'report'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get(
    '/api/v1/staff/funnel',
    { config: { roles: ['admin' as const, 'agent' as const] } },
    async (req) => funnel.report(actor(req), funnelQuerySchema.parse(req.query)),
  );
}
