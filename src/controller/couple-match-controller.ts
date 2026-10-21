import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  markMatchedSchema,
  removeStorySchema,
  storyStatusSchema,
  undoMatchSchema,
} from '../bo/couple-match.js';
import type { CoupleMatchService } from '../service/couple-match-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const adminOnly = { roles: ['admin' as const] };
const connectionParams = z.object({ connectionId: z.uuid() });
const storyParams = z.object({ storyId: z.uuid() });

/** The matched step and the publishing of success stories (see bo/couple-match.ts). */
export function registerCoupleMatchController(
  app: FastifyInstance,
  matches: Pick<CoupleMatchService, 'markMatched' | 'undoMatch' | 'setStoryStatus' | 'removeStory'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const write = { rateLimit: { max: 30, timeWindow: 60000 } };

  app.post(
    '/api/v1/staff/connections/:connectionId/match',
    { config: { ...staffOnly, ...write } },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await matches.markMatched(
            actor(req),
            connectionParams.parse(req.params).connectionId,
            markMatchedSchema.parse(req.body ?? {}),
            req.id,
          ),
        ),
  );

  app.post(
    '/api/v1/staff/connections/:connectionId/match/undo',
    { config: { ...staffOnly, ...write } },
    async (req, reply) => {
      await matches.undoMatch(
        actor(req),
        connectionParams.parse(req.params).connectionId,
        undoMatchSchema.parse(req.body),
        req.id,
      );
      return reply.code(204).send();
    },
  );

  app.put(
    '/api/v1/admin/success-stories/:storyId/status',
    { config: { ...adminOnly, ...write } },
    async (req, reply) => {
      await matches.setStoryStatus(
        actor(req),
        storyParams.parse(req.params).storyId,
        storyStatusSchema.parse(req.body).status,
        req.id,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/admin/success-stories/:storyId/remove',
    { config: { ...adminOnly, ...write } },
    async (req, reply) => {
      await matches.removeStory(
        actor(req),
        storyParams.parse(req.params).storyId,
        removeStorySchema.parse(req.body).reason,
        req.id,
      );
      return reply.code(204).send();
    },
  );
}
