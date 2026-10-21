import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serviceTermsInputSchema } from '../bo/service-terms.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { ServiceTermsService } from '../service/service-terms-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const clientParams = z.object({ profileId: z.uuid() });

/**
 * The terms of a client's service: staff record them for the clients they look after and may record that the
 * client agreed in the office; a member reads and confirms their own.
 */
export function registerServiceTermsController(
  app: FastifyInstance,
  terms: Pick<ServiceTermsService, 'state' | 'record' | 'acknowledge'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const client = (req: { params: unknown }) => ({
    kind: 'client' as const,
    profileId: clientParams.parse(req.params).profileId,
  });

  app.get('/api/v1/me/service-terms', { config: memberOnly }, async (req) =>
    terms.state(actor(req), { kind: 'own' }),
  );
  app.post(
    '/api/v1/me/service-terms/confirm',
    { config: { ...memberOnly, rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req) => terms.acknowledge(actor(req), { kind: 'own' }, req.id),
  );

  app.get('/api/v1/staff/clients/:profileId/service-terms', { config: staffOnly }, async (req) =>
    terms.state(actor(req), client(req)),
  );
  app.put('/api/v1/staff/clients/:profileId/service-terms', { config: staffOnly }, async (req) =>
    terms.record(
      actor(req),
      client(req).profileId,
      serviceTermsInputSchema.parse(req.body),
      req.id,
    ),
  );
  app.post(
    '/api/v1/staff/clients/:profileId/service-terms/confirm',
    { config: staffOnly },
    async (req) => terms.acknowledge(actor(req), client(req), req.id),
  );
}
