import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import {
  clientLoginAcceptSchema,
  clientLoginGrantSchema,
  clientLoginLinkSchema,
} from '../bo/client-login.js';
import { AppError } from '../exception/app-error.js';
import type { ClientLoginProcess } from '../process/client-login-process.js';
import { tokensResponseSchema } from '../io/http/contracts.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const params = z.object({ profileId: z.uuid() });

/**
 * Giving a client a login. The staff routes are for an admin or the agent who looks after the client.
 * The two routes the client uses (previewing and opening the link) are public, like the other emailed
 * links, and only work from this site's own pages.
 */
export function registerClientLoginController(
  app: FastifyInstance,
  logins: Pick<ClientLoginProcess, 'status' | 'grant' | 'revoke' | 'preview' | 'accept'>,
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
  const profileId = (req: FastifyRequest) => params.parse(req.params).profileId;
  const requireSameOrigin = (req: FastifyRequest) => {
    if (req.headers.origin !== req.canonicalOrigin) throw new AppError(403, 'ORIGIN_INVALID');
  };

  app.get('/api/v1/staff/clients/:profileId/login', { config: staffOnly }, async (req) =>
    logins.status(actor(req), profileId(req)),
  );

  // Each request sends a message, so this has a tighter limit than the other staff routes.
  app.post(
    '/api/v1/staff/clients/:profileId/login',
    { config: { ...staffOnly, rateLimit: { max: 30, timeWindow: 600000 } } },
    async (req, reply) => {
      const status = await logins.grant(
        context(req),
        actor(req),
        profileId(req),
        clientLoginGrantSchema.parse(req.body),
        req.id,
      );
      return reply.code(201).send(status);
    },
  );

  app.delete(
    '/api/v1/staff/clients/:profileId/login',
    { config: staffOnly },
    async (req, reply) => {
      await logins.revoke(actor(req), profileId(req), req.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/auth/client-login/preview',
    { config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req) => {
      requireSameOrigin(req);
      const { token } = clientLoginLinkSchema.parse(req.body);
      return logins.preview(req.tenant!.id, token);
    },
  );

  app.post(
    '/api/v1/auth/client-login/accept',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const result = await logins.accept(
        req.tenant!.id,
        clientLoginAcceptSchema.parse(req.body),
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
}
