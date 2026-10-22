import type { FastifyInstance } from 'fastify';
import { messagePreferenceSchema } from '../bo/messaging.js';
import type { MessagingService } from '../service/messaging-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

/** A member's choice of texts outside the app, and for an admin what was sent (see bo/messaging.ts). */
export function registerMessagingController(
  app: FastifyInstance,
  messaging: Pick<MessagingService, 'get' | 'set' | 'usage'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const member = { roles: ['member' as const] };

  app.get('/api/v1/me/message-preferences', { config: member }, async (req) =>
    messaging.get(actor(req)),
  );
  app.put(
    '/api/v1/me/message-preferences',
    { config: { ...member, rateLimit: { max: 20, timeWindow: 3600000 } } },
    async (req) =>
      messaging.set(actor(req), messagePreferenceSchema.parse(req.body).channel, req.id),
  );
  app.get(
    '/api/v1/admin/reports/messages',
    { config: { roles: ['admin' as const] } },
    async (req) => messaging.usage(actor(req)),
  );
}
