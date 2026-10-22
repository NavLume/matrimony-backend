import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { flagListQuerySchema, flagReviewSchema, signalParamSchema } from '../bo/flags.js';
import type { FlagService } from '../service/flag-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const clientParams = z.object({ profileId: z.uuid() });

/** Fraud signals for staff (see bo/flags.ts). Never reachable by a member or a guardian. */
export function registerFlagController(
  app: FastifyInstance,
  flags: Pick<FlagService, 'list' | 'forClient' | 'review'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/staff/flags', { config: staffOnly }, async (req) => ({
    items: await flags.list(actor(req), flagListQuerySchema.parse(req.query).state),
  }));
  app.get('/api/v1/staff/clients/:profileId/flags', { config: staffOnly }, async (req) => ({
    items: await flags.forClient(actor(req), clientParams.parse(req.params).profileId),
  }));
  app.post(
    '/api/v1/staff/clients/:profileId/flags/:signal/review',
    { config: staffOnly },
    async (req) => {
      const params = clientParams.extend({ signal: signalParamSchema }).parse(req.params);
      return {
        items: await flags.review(
          actor(req),
          params.profileId,
          params.signal,
          flagReviewSchema.parse(req.body).outcome,
          req.id,
        ),
      };
    },
  );
}
