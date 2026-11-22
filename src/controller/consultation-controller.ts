import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  consultationActionSchema,
  consultationCodeSchema,
  consultationInputSchema,
  leadAssignSchema,
  leadLinkSchema,
  leadLookupQuerySchema,
  referenceSchema,
  staffLeadQuerySchema,
  staffLeadUpdateSchema,
  unverifiedInputSchema,
} from '../bo/consultation.js';
import { leadCallSchema } from '../bo/lead-follow-up.js';
import { AppError } from '../exception/app-error.js';
import type { ConsultationProcess } from '../process/consultation-process.js';
import type { ConsultationService } from '../service/consultation-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const idParams = z.object({ id: z.uuid() });
const profileParams = z.object({ profileId: z.uuid() });
const referenceParams = z.object({ reference: referenceSchema });

/**
 * Talk to an adviser (see bo/consultation.ts): the visitor's code, enquiry, unverified call request and next step
 * (call, call me, office visit, WhatsApp), and the staff list of enquiries.
 */
export function registerConsultationController(
  app: FastifyInstance,
  service: Pick<
    ConsultationService,
    | 'requestUnverified'
    | 'act'
    | 'list'
    | 'update'
    | 'assign'
    | 'ofClient'
    | 'lookup'
    | 'linkClient'
    | 'unlinkClient'
    | 'addCall'
  >,
  process: Pick<ConsultationProcess, 'sendCode' | 'submit'>,
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
  const ownHost = (req: FastifyRequest) => {
    try {
      return new URL(req.canonicalOrigin).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  };

  // ---- public ----------------------------------------------------------------------------------

  // Tight limits by address, on top of those by number and agency that the code process keeps.
  app.post(
    '/api/v1/public/consultations/code',
    { config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } } },
    async (req, reply) => {
      sameOrigin(req);
      const sent = await process.sendCode(
        { agencyId: req.tenant!.id, agencyName: req.tenant!.name },
        consultationCodeSchema.parse(req.body),
        ownHost(req),
      );
      return reply.code(202).send({ status: 'code_sent', ...sent });
    },
  );

  app.post(
    '/api/v1/public/consultations',
    { config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } } },
    async (req, reply) => {
      sameOrigin(req);
      const result = await process.submit(
        req.tenant!.id,
        consultationInputSchema.parse(req.body),
        ownHost(req),
      );
      return reply
        .code(result.returning ? 200 : 201)
        .header('cache-control', 'no-store')
        .send(result);
    },
  );

  // The code never arrived. Stricter limit: nothing proves the number, so it must not become a way to flood staff.
  app.post(
    '/api/v1/public/consultations/unverified',
    { config: { public: true, rateLimit: { max: 5, timeWindow: 600000 } } },
    async (req, reply) => {
      sameOrigin(req);
      await service.requestUnverified(
        req.tenant!.id,
        unverifiedInputSchema.parse(req.body),
        ownHost(req),
      );
      return reply.code(202).send({ status: 'received' });
    },
  );

  app.post(
    '/api/v1/public/consultations/:reference/actions',
    { config: { public: true, rateLimit: { max: 20, timeWindow: 600000 } } },
    async (req, reply) => {
      sameOrigin(req);
      const { reference } = referenceParams.parse(req.params);
      await service.act(req.tenant!.id, reference, consultationActionSchema.parse(req.body));
      return reply.code(204).send();
    },
  );

  // ---- staff -----------------------------------------------------------------------------------

  app.get('/api/v1/staff/leads', { config: staffOnly }, async (req) => ({
    leads: await service.list(actor(req), staffLeadQuerySchema.parse(req.query)),
  }));

  // The office finds an enquiry by its reference or full number while creating a client.
  app.get(
    '/api/v1/staff/leads/lookup',
    { config: { ...staffOnly, ...write } },
    async (req, reply) =>
      reply.header('cache-control', 'no-store').send({
        matches: await service.lookup(actor(req), leadLookupQuerySchema.parse(req.query).q),
      }),
  );

  app.put('/api/v1/staff/leads/:id', { config: { ...staffOnly, ...write } }, async (req) => ({
    lead: await service.update(
      actor(req),
      idParams.parse(req.params).id,
      staffLeadUpdateSchema.parse(req.body),
      req.id,
    ),
  }));

  // The enquiries that became a client (the proof of where the client came from).
  app.get('/api/v1/staff/clients/:profileId/leads', { config: staffOnly }, async (req) => ({
    leads: await service.ofClient(actor(req), profileParams.parse(req.params).profileId),
  }));

  // A call to an enquiry and what came of it (the first one stops the follow-up reminders).
  app.post(
    '/api/v1/staff/leads/:id/calls',
    { config: { ...staffOnly, ...write } },
    async (req, reply) =>
      reply.code(201).send({
        lead: await service.addCall(
          actor(req),
          idParams.parse(req.params).id,
          leadCallSchema.parse(req.body),
          req.id,
        ),
      }),
  );

  app.put(
    '/api/v1/staff/leads/:id/client',
    { config: { ...staffOnly, ...write } },
    async (req) => ({
      lead: await service.linkClient(
        actor(req),
        idParams.parse(req.params).id,
        leadLinkSchema.parse(req.body).memberCode,
        req.id,
      ),
    }),
  );

  app.delete(
    '/api/v1/admin/leads/:id/client',
    { config: { ...adminOnly, ...write } },
    async (req) => ({
      lead: await service.unlinkClient(actor(req), idParams.parse(req.params).id, req.id),
    }),
  );

  app.put('/api/v1/admin/leads/:id/agent', { config: { ...adminOnly, ...write } }, async (req) => ({
    lead: await service.assign(
      actor(req),
      idParams.parse(req.params).id,
      leadAssignSchema.parse(req.body).agentId,
      req.id,
    ),
  }));
}
