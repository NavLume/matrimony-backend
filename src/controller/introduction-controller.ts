import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { introductionRangeSchema } from '../bo/introduction.js';
import type { IntroductionService } from '../service/introduction-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const connectionParams = z.object({ connectionId: z.uuid() });

/** The introduction ledger (see bo/introduction.ts). Staff only; the per-agent report is for admins. */
export function registerIntroductionController(
  app: FastifyInstance,
  introductions: Pick<IntroductionService, 'history' | 'byAgent'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get(
    '/api/v1/staff/connections/:connectionId/history',
    { config: { roles: ['admin' as const, 'agent' as const] } },
    async (req) =>
      introductions.history(actor(req), connectionParams.parse(req.params).connectionId),
  );
  app.get(
    '/api/v1/admin/reports/introductions',
    { config: { roles: ['admin' as const] } },
    async (req) => ({
      items: await introductions.byAgent(actor(req), introductionRangeSchema.parse(req.query)),
    }),
  );
}
