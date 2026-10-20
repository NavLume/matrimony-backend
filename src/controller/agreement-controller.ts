import type { FastifyInstance } from 'fastify';
import { acceptAgreementsSchema } from '../bo/agreements.js';
import type { AgreementService } from '../service/agreement-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

/** Reading and giving the agreement to the agency's current terms and privacy text. */
export function registerAgreementController(
  app: FastifyInstance,
  agreements: Pick<AgreementService, 'status' | 'accept'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/me/agreements', async (req) => agreements.status(actor(req)));

  app.post(
    '/api/v1/me/agreements',
    { config: { rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req) => {
      acceptAgreementsSchema.parse(req.body ?? {});
      return agreements.accept(actor(req), req.id);
    },
  );
}
