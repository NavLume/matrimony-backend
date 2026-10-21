import type { FastifyInstance } from 'fastify';
import { settingsInputSchema } from '../bo/agency-settings.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { SettingsService } from '../service/settings-service.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };

/** The agency's own settings. Admins only. */
export function registerSettingsController(
  app: FastifyInstance,
  settings: Pick<SettingsService, 'get' | 'save'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/admin/settings', { config: adminOnly }, async (req) => settings.get(actor(req)));
  app.put('/api/v1/admin/settings', { config: adminOnly }, async (req) =>
    settings.save(actor(req), settingsInputSchema.parse(req.body), req.id),
  );
}
