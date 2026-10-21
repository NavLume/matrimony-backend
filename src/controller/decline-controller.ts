import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeclineService } from '../service/decline-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const clientParams = z.object({ profileId: z.uuid() });

/** What clients said no to, counted by reason (see bo/decline.ts). Staff only. */
export function registerDeclineController(
  app: FastifyInstance,
  declines: Pick<DeclineService, 'forClient' | 'forAgency'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get(
    '/api/v1/staff/clients/:profileId/decline-patterns',
    { config: { roles: ['admin' as const, 'agent' as const] } },
    async (req) => declines.forClient(actor(req), clientParams.parse(req.params).profileId),
  );
  app.get(
    '/api/v1/admin/reports/decline-patterns',
    { config: { roles: ['admin' as const] } },
    async (req) => declines.forAgency(actor(req)),
  );
}
