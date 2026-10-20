import type { FastifyInstance } from 'fastify';
import { activityQuerySchema } from '../bo/activity.js';
import type { ActivityService } from '../service/activity-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

/** The activity log (see bo/activity.ts). Admins only, read only. */
export function registerActivityController(
  app: FastifyInstance,
  activity: Pick<ActivityService, 'list'>,
) {
  app.get(
    '/api/v1/admin/activity',
    { config: { roles: ['admin' as const], rateLimit: { max: 60, timeWindow: 60000 } } },
    async (req) =>
      activity.list(
        {
          agencyId: req.principal!.agencyId,
          accountId: req.principal!.id,
          role: req.principal!.role,
        } as ProfileActor,
        activityQuerySchema.parse(req.query),
      ),
  );
}
