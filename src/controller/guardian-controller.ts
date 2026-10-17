import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adviceInputSchema,
  guardianAcceptSchema,
  guardianInviteSchema,
  guardianLinkSchema,
} from '../bo/guardian.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../exception/app-error.js';
import { tokensResponseSchema } from '../io/http/contracts.js';
import type { GuardianProcess } from '../process/guardian-process.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const memberOnly = { roles: ['member' as const] };
const guardianOnly = { roles: ['guardian' as const] };
const profileParams = z.object({ profileId: z.uuid() });
const connectionParams = z.object({ connectionId: z.uuid() });

/**
 * A client's guardian (see bo/guardian.ts). The agency asks for one, the client agrees (or the agent
 * records that a client with no login agreed), the guardian opens the emailed link to choose a
 * password, and then sees the client's proposals and advises. The two link routes are public, like the
 * other emailed links, and only work from this site's own pages.
 */
export function registerGuardianController(
  app: FastifyInstance,
  guardians: Pick<
    GuardianProcess,
    | 'stateForStaff'
    | 'invite'
    | 'resend'
    | 'removeByStaff'
    | 'stateForClient'
    | 'approve'
    | 'removeByClient'
    | 'preview'
    | 'accept'
    | 'ward'
    | 'advise'
  >,
  config: AppConfig,
) {
  const prefix = config.NODE_ENV === 'production' ? '__Host-' : '';
  const sessionCookie = `${prefix}matrimony-session`;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
  };
  const context = (req: FastifyRequest) => ({
    agencyId: req.tenant!.id,
    agencyName: req.tenant!.name,
    origin: req.canonicalOrigin,
  });
  const actor = (req: FastifyRequest) => ({
    agencyId: req.tenant!.id,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const profileId = (req: FastifyRequest) => profileParams.parse(req.params).profileId;
  const requireSameOrigin = (req: FastifyRequest) => {
    if (req.headers.origin !== req.canonicalOrigin) throw new AppError(403, 'ORIGIN_INVALID');
  };
  // Each of these sends an email, so they have a tighter limit than the other routes.
  const sends = { rateLimit: { max: 30, timeWindow: 600000 } };

  // ---- the agency ----------------------------------------------------------------------------
  app.get('/api/v1/staff/clients/:profileId/guardian', { config: staffOnly }, async (req) =>
    guardians.stateForStaff(actor(req), profileId(req)),
  );
  app.post(
    '/api/v1/staff/clients/:profileId/guardian',
    { config: { ...staffOnly, ...sends } },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await guardians.invite(
            context(req),
            actor(req),
            profileId(req),
            guardianInviteSchema.parse(req.body),
            req.id,
          ),
        ),
  );
  app.post(
    '/api/v1/staff/clients/:profileId/guardian/resend',
    { config: { ...staffOnly, ...sends } },
    async (req) => guardians.resend(context(req), actor(req), profileId(req), req.id),
  );
  app.delete('/api/v1/staff/clients/:profileId/guardian', { config: staffOnly }, async (req) =>
    guardians.removeByStaff(actor(req), profileId(req), req.id),
  );

  // ---- the client ----------------------------------------------------------------------------
  app.get('/api/v1/me/guardian', { config: memberOnly }, async (req) =>
    guardians.stateForClient(actor(req)),
  );
  app.post('/api/v1/me/guardian/approve', { config: { ...memberOnly, ...sends } }, async (req) =>
    guardians.approve(context(req), actor(req), req.id),
  );
  app.delete('/api/v1/me/guardian', { config: memberOnly }, async (req) =>
    guardians.removeByClient(actor(req), req.id),
  );

  // ---- the link ------------------------------------------------------------------------------
  app.post(
    '/api/v1/auth/guardian-invitation/preview',
    { config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req) => {
      requireSameOrigin(req);
      return guardians.preview(req.tenant!.id, guardianLinkSchema.parse(req.body).token);
    },
  );
  app.post(
    '/api/v1/auth/guardian-invitation/accept',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const result = await guardians.accept(
        req.tenant!.id,
        guardianAcceptSchema.parse(req.body),
        req.id,
      );
      reply.setCookie(sessionCookie, result.sessionId, {
        ...cookieOptions,
        maxAge: config.SESSION_TTL_SECONDS,
      });
      return {
        accessToken: result.accessToken,
        csrfToken: result.csrfToken,
        expiresIn: result.expiresIn,
      };
    },
  );

  // ---- the guardian --------------------------------------------------------------------------
  app.get('/api/v1/guardian/ward', { config: guardianOnly }, async (req) =>
    guardians.ward(actor(req)),
  );
  app.put(
    '/api/v1/guardian/connections/:connectionId/advice',
    { config: { ...guardianOnly, rateLimit: { max: 60, timeWindow: 60000 } } },
    async (req, reply) => {
      await guardians.advise(
        actor(req),
        connectionParams.parse(req.params).connectionId,
        adviceInputSchema.parse(req.body),
        req.id,
      );
      return reply.code(204).send();
    },
  );
}
