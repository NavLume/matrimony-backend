import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  browseQuerySchema,
  introductionRequestSchema,
  LEAD_STATUSES,
  leadCodeInputSchema,
  leadInputSchema,
  leadUpdateSchema,
  showcaseEntrySchema,
  showcaseSettingsSchema,
  websiteVisibilitySchema,
} from '../bo/showcase.js';
import { AppError } from '../exception/app-error.js';
import type { ShowcaseProcess } from '../process/showcase-process.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { ShowcaseService } from '../service/showcase-service.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };
const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const refParams = z.object({ ref: z.uuid() });
const profileParams = z.object({ profileId: z.uuid() });
const idParams = z.object({ id: z.uuid() });

/**
 * "Meet our members" (see bo/showcase.ts): the public cards and their blurred pictures, a visitor's request to be
 * called, the admin's controls and the "show on the website" switch.
 */
export function registerShowcaseController(
  app: FastifyInstance,
  showcase: Pick<
    ShowcaseService,
    | 'overview'
    | 'setSettings'
    | 'addEntry'
    | 'removeEntry'
    | 'leads'
    | 'updateLead'
    | 'hidden'
    | 'setHidden'
    | 'requestIntroduction'
  >,
  process: Pick<ShowcaseProcess, 'cards' | 'browse' | 'photo' | 'sendCode' | 'submit'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const write = { rateLimit: { max: 30, timeWindow: 60000 } };
  const sameOrigin = (req: FastifyRequest) => {
    if (req.headers.origin !== req.canonicalOrigin) throw new AppError(403, 'ORIGIN_INVALID');
  };

  // ---- public ----------------------------------------------------------------------------------

  app.get(
    '/api/v1/public/showcase',
    { config: { public: true, rateLimit: { max: 60, timeWindow: 60000 } } },
    async (req, reply) =>
      reply
        .header('cache-control', 'public, max-age=60')
        .send({ cards: await process.cards(req.tenant!.id) }),
  );

  // The browse page: the same cards, filtered, a page at a time.
  app.get(
    '/api/v1/public/showcase/browse',
    { config: { public: true, rateLimit: { max: 60, timeWindow: 60000 } } },
    async (req, reply) => {
      const query = browseQuerySchema.parse(req.query);
      return reply.header('cache-control', 'public, max-age=60').send(
        await process.browse(
          req.tenant!.id,
          {
            district: query.district ?? null,
            religion: query.religion ?? null,
            profession: query.profession ?? null,
            country: query.country ?? null,
            ageMin: query.ageMin ?? null,
            ageMax: query.ageMax ?? null,
          },
          query.page,
        ),
      );
    },
  );

  // Heavily blurred and tiny; cached only briefly so switching a profile off takes effect quickly.
  app.get(
    '/api/v1/public/showcase/:ref/photo',
    { config: { public: true, rateLimit: { max: 120, timeWindow: 60000 } } },
    async (req, reply) => {
      const { ref } = refParams.parse(req.params);
      return reply
        .header('content-type', 'image/webp')
        .header('cache-control', 'public, max-age=300')
        .header('x-content-type-options', 'nosniff')
        .send(await process.photo(req.tenant!.id, ref));
    },
  );

  // A text-message code for a visitor who wants a call. Tight limits by address, on top of those by number and agency.
  app.post(
    '/api/v1/public/showcase/leads/code',
    { config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } } },
    async (req, reply) => {
      sameOrigin(req);
      const input = leadCodeInputSchema.parse(req.body);
      const sent = await process.sendCode(
        { agencyId: req.tenant!.id, agencyName: req.tenant!.name },
        input.phone,
        input.locale,
      );
      return reply.code(202).send({ status: 'code_sent', ...sent });
    },
  );

  app.post(
    '/api/v1/public/showcase/leads',
    { config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } } },
    async (req, reply) => {
      sameOrigin(req);
      await process.submit(req.tenant!.id, leadInputSchema.parse(req.body));
      return reply.code(201).send({ status: 'received' });
    },
  );

  // ---- the admin -------------------------------------------------------------------------------

  app.get('/api/v1/admin/showcase', { config: adminOnly }, async (req) =>
    showcase.overview(actor(req)),
  );
  app.put(
    '/api/v1/admin/showcase/settings',
    { config: { ...adminOnly, ...write } },
    async (req, reply) => {
      await showcase.setSettings(actor(req), showcaseSettingsSchema.parse(req.body), req.id);
      return reply.code(204).send();
    },
  );
  app.post(
    '/api/v1/admin/showcase/entries',
    { config: { ...adminOnly, ...write } },
    async (req, reply) => {
      await showcase.addEntry(actor(req), showcaseEntrySchema.parse(req.body).profileId, req.id);
      return reply.code(204).send();
    },
  );
  app.delete(
    '/api/v1/admin/showcase/entries/:profileId',
    { config: { ...adminOnly, ...write } },
    async (req, reply) => {
      await showcase.removeEntry(actor(req), profileParams.parse(req.params).profileId, req.id);
      return reply.code(204).send();
    },
  );
  app.get('/api/v1/admin/leads', { config: adminOnly }, async (req) => {
    const { status } = z.object({ status: z.enum(LEAD_STATUSES).optional() }).parse(req.query);
    return { leads: await showcase.leads(actor(req), status ?? null) };
  });
  app.put('/api/v1/admin/leads/:id', { config: { ...adminOnly, ...write } }, async (req, reply) => {
    await showcase.updateLead(
      actor(req),
      idParams.parse(req.params).id,
      leadUpdateSchema.parse(req.body),
      req.id,
    );
    return reply.code(204).send();
  });

  // A signed-in member tells their agent which card they liked (an agenda reminder for the agent).
  app.post(
    '/api/v1/me/showcase-requests',
    { config: { ...memberOnly, rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req, reply) => {
      const input = introductionRequestSchema.parse(req.body);
      const result = await showcase.requestIntroduction(actor(req), input.ref, input.note, req.id);
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  // ---- the "show on the website" switch --------------------------------------------------------

  app.get('/api/v1/me/profile/website-visibility', { config: memberOnly }, async (req) => ({
    hidden: await showcase.hidden(actor(req), { kind: 'own' }),
  }));
  app.put(
    '/api/v1/me/profile/website-visibility',
    { config: { ...memberOnly, ...write } },
    async (req, reply) => {
      await showcase.setHidden(
        actor(req),
        websiteVisibilitySchema.parse(req.body).hidden,
        { kind: 'own' },
        req.id,
      );
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/v1/staff/clients/:profileId/website-visibility',
    { config: staffOnly },
    async (req) => ({
      hidden: await showcase.hidden(actor(req), {
        kind: 'client',
        profileId: profileParams.parse(req.params).profileId,
      }),
    }),
  );
  app.put(
    '/api/v1/staff/clients/:profileId/website-visibility',
    { config: { ...staffOnly, ...write } },
    async (req, reply) => {
      await showcase.setHidden(
        actor(req),
        websiteVisibilitySchema.parse(req.body).hidden,
        { kind: 'client', profileId: profileParams.parse(req.params).profileId },
        req.id,
      );
      return reply.code(204).send();
    },
  );
}
