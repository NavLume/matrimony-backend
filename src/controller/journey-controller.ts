import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JourneyService } from '../service/journey-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const clientParams = z.object({ profileId: z.uuid() });

/** A client's journey: a member reads their own, staff read the clients they look after. */
export function registerJourneyController(
  app: FastifyInstance,
  journey: Pick<JourneyService, 'get'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/me/journey', { config: memberOnly }, async (req) =>
    journey.get(actor(req), { kind: 'own' }),
  );
  app.get('/api/v1/staff/clients/:profileId/journey', { config: staffOnly }, async (req) =>
    journey.get(actor(req), {
      kind: 'client',
      profileId: clientParams.parse(req.params).profileId,
    }),
  );
}
