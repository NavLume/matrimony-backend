import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { matchQuerySchema } from '../bo/matches.js';
import { matchPageResponse, profileDetailResponse } from '../factory/match-response.js';
import type { MatchProcess } from '../process/match-process.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const memberOrGuardian = { roles: ['member' as const, 'guardian' as const] };
const params = z.object({ candidateId: z.uuid() });
const imageQuery = z.object({ size: z.enum(['full', 'thumb']).default('thumb') });

/** A member's own matches: the profiles staff released to them, and nothing else. */
export function registerMatchController(
  app: FastifyInstance,
  matches: Pick<MatchProcess, 'page' | 'detail' | 'photo'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/me/matches', { config: memberOnly }, async (req) =>
    matchPageResponse(await matches.page(actor(req), matchQuerySchema.parse(req.query))),
  );

  app.get('/api/v1/me/matches/:candidateId', { config: memberOrGuardian }, async (req) =>
    profileDetailResponse(await matches.detail(actor(req), params.parse(req.params).candidateId)),
  );

  app.get(
    '/api/v1/me/matches/:candidateId/photo',
    { config: memberOrGuardian },
    async (req, reply) => {
      const { candidateId } = params.parse(req.params);
      const { size } = imageQuery.parse(req.query);
      const bytes = await matches.photo(actor(req), candidateId, size);
      // Private to this member's browser, and kept only briefly: the picture changes from blurred to clear when a
      // proposal is accepted, and a clear one carries this viewer's code.
      return reply
        .header('content-type', 'image/webp')
        .header('cache-control', 'private, max-age=60')
        .send(bytes);
    },
  );
}
