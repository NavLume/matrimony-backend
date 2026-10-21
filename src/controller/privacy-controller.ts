import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eraseClientSchema } from '../bo/privacy.js';
import type { PrivacyService } from '../service/privacy-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const clientParams = z.object({ profileId: z.uuid() });

/**
 * A person's consent log and data copy, and erasing a client with no login (see bo/privacy.ts). A copy of
 * someone's data is never cached by the browser or a proxy.
 */
export function registerPrivacyController(
  app: FastifyInstance,
  privacy: Pick<
    PrivacyService,
    | 'myConsents'
    | 'myExport'
    | 'clientConsents'
    | 'clientExport'
    | 'erasureState'
    | 'scheduleErasure'
    | 'cancelErasure'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/me/consents', { config: memberOnly }, async (req) => ({
    items: await privacy.myConsents(actor(req)),
  }));

  // A copy of the member's data: a few an hour is plenty, and each one is recorded.
  app.get(
    '/api/v1/me/data-export',
    { config: { ...memberOnly, rateLimit: { max: 5, timeWindow: 3600000 } } },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return privacy.myExport(actor(req), req.id);
    },
  );

  app.get('/api/v1/staff/clients/:profileId/consents', { config: staffOnly }, async (req) => {
    const { profileId } = clientParams.parse(req.params);
    return { items: await privacy.clientConsents(actor(req), profileId) };
  });

  app.get(
    '/api/v1/staff/clients/:profileId/data-export',
    { config: { ...staffOnly, rateLimit: { max: 20, timeWindow: 3600000 } } },
    async (req, reply) => {
      const { profileId } = clientParams.parse(req.params);
      reply.header('cache-control', 'no-store');
      return privacy.clientExport(actor(req), profileId, req.id);
    },
  );

  app.get('/api/v1/staff/clients/:profileId/erasure', { config: staffOnly }, async (req) => {
    const { profileId } = clientParams.parse(req.params);
    return privacy.erasureState(actor(req), profileId);
  });

  // Asking for an erasure: admins only, the client's member code is typed and a reason is given. The profile is
  // hidden now and erased after 7 days unless an admin cancels.
  app.post(
    '/api/v1/staff/clients/:profileId/erase',
    { config: { roles: ['admin' as const], rateLimit: { max: 10, timeWindow: 3600000 } } },
    async (req, reply) => {
      const { profileId } = clientParams.parse(req.params);
      const { memberCode, reason } = eraseClientSchema.parse(req.body);
      const result = await privacy.scheduleErasure(
        actor(req),
        profileId,
        memberCode,
        reason,
        req.id,
      );
      return reply.code(202).send(result);
    },
  );

  app.post(
    '/api/v1/staff/clients/:profileId/erase/cancel',
    { config: { roles: ['admin' as const] } },
    async (req, reply) => {
      const { profileId } = clientParams.parse(req.params);
      await privacy.cancelErasure(actor(req), profileId, req.id);
      return reply.code(204).send();
    },
  );
}
