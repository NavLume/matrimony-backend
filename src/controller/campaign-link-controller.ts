import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { campaignLinkInputSchema, campaignLinkQuerySchema } from '../bo/campaign-link.js';
import type { CampaignLinkService } from '../service/campaign-link-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const write = { rateLimit: { max: 30, timeWindow: 60000 } };
const idParams = z.object({ id: z.uuid() });
const archiveBody = z.object({ archived: z.boolean() }).strict();

/** The links page: tagged links and QR codes staff make for each place they share the site (bo/campaign-link.ts). */
export function registerCampaignLinkController(
  app: FastifyInstance,
  service: Pick<CampaignLinkService, 'list' | 'create' | 'archive'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/staff/campaign-links', { config: staffOnly }, async (req) => ({
    links: await service.list(
      actor(req),
      campaignLinkQuerySchema.parse(req.query).archived === 'true',
    ),
  }));

  app.post(
    '/api/v1/staff/campaign-links',
    { config: { ...staffOnly, ...write } },
    async (req, reply) =>
      reply.code(201).send({
        link: await service.create(actor(req), campaignLinkInputSchema.parse(req.body), req.id),
      }),
  );

  app.put(
    '/api/v1/staff/campaign-links/:id/archived',
    { config: { ...staffOnly, ...write } },
    async (req) => ({
      link: await service.archive(
        actor(req),
        idParams.parse(req.params).id,
        archiveBody.parse(req.body).archived,
        req.id,
      ),
    }),
  );
}
