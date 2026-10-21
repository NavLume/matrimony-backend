import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  concernInputSchema,
  concernListQuerySchema,
  recordConcernSchema,
  resolveInputSchema,
} from '../bo/concern.js';
import type { ConcernService } from '../service/concern-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const idParams = z.object({ concernId: z.uuid() });
const clientParams = z.object({ profileId: z.uuid() });

/**
 * Private concerns: a member reports and reads their own; an admin reads all of them, and an agent only those
 * about a profile of a client they look after (see bo/concern.ts). Both can write the outcome of what they read.
 */
export function registerConcernController(
  app: FastifyInstance,
  concerns: Pick<ConcernService, 'report' | 'mine' | 'list' | 'resolve' | 'recordFor'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/me/concerns', { config: memberOnly }, async (req) => ({
    items: await concerns.mine(actor(req)),
  }));
  app.post(
    '/api/v1/me/concerns',
    { config: { ...memberOnly, rateLimit: { max: 10, timeWindow: 3600000 } } },
    async (req, reply) => {
      const items = await concerns.report(actor(req), concernInputSchema.parse(req.body), req.id);
      return reply.code(201).send({ items });
    },
  );

  app.get('/api/v1/staff/concerns', { config: staffOnly }, async (req) => ({
    items: await concerns.list(actor(req), concernListQuerySchema.parse(req.query).status),
  }));
  app.post('/api/v1/staff/concerns/:concernId/resolve', { config: staffOnly }, async (req) => ({
    items: await concerns.resolve(
      actor(req),
      idParams.parse(req.params).concernId,
      resolveInputSchema.parse(req.body).note,
      req.id,
    ),
  }));

  // Staff record a concern for a client who has no login.
  app.post(
    '/api/v1/staff/clients/:profileId/concerns',
    { config: { ...staffOnly, rateLimit: { max: 20, timeWindow: 3600000 } } },
    async (req, reply) => {
      const items = await concerns.recordFor(
        actor(req),
        clientParams.parse(req.params).profileId,
        recordConcernSchema.parse(req.body),
        req.id,
      );
      return reply.code(201).send({ items });
    },
  );
}
