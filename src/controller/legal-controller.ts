import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { legalInputSchema, legalKindSchema } from '../bo/legal.js';
import type { LegalService } from '../service/legal-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };
const kindParams = z.object({ kind: legalKindSchema });

/** The agency's terms and privacy policy: public to read, written by the agency admin (see bo/legal.ts). */
export function registerLegalController(
  app: FastifyInstance,
  legal: Pick<LegalService, 'publicDocument' | 'get' | 'save'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/public/legal/:kind', { config: { public: true } }, async (req) =>
    legal.publicDocument(req.tenant!.id, kindParams.parse(req.params).kind),
  );

  app.get('/api/v1/admin/legal', { config: adminOnly }, async (req) => legal.get(actor(req)));

  app.put(
    '/api/v1/admin/legal/:kind',
    {
      config: { ...adminOnly, rateLimit: { max: 20, timeWindow: 60000 } },
      bodyLimit: 400 * 1024,
    },
    async (req) =>
      legal.save(
        actor(req),
        kindParams.parse(req.params).kind,
        legalInputSchema.parse(req.body ?? {}),
        req.id,
      ),
  );
}
