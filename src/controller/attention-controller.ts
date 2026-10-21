import type { FastifyInstance } from 'fastify';
import type { AttentionService } from '../service/attention-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };

/** What has waited too long, for the agenda. */
export function registerAttentionController(
  app: FastifyInstance,
  attention: Pick<AttentionService, 'get'>,
) {
  app.get('/api/v1/staff/attention', { config: staffOnly }, async (req) =>
    attention.get({
      agencyId: req.principal!.agencyId,
      accountId: req.principal!.id,
      role: req.principal!.role as ProfileActor['role'],
    }),
  );
}
