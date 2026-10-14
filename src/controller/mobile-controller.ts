import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MobileService } from '../service/mobile-service.js';

const byCode = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,12}$/),
});
const version = z.object({
  platform: z.enum(['ios', 'android']),
  version: z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/),
});

/**
 * The two questions a mobile app asks before anyone signs in. Neither names an agency in the address
 * the app reaches, so neither needs the tenant lookup that every other route starts with.
 */
export function registerMobileController(
  app: FastifyInstance,
  mobile: Pick<MobileService, 'agencyByCode' | 'versionStatus'>,
) {
  // A code can be tried again and again, so this has a tighter limit than the other public routes.
  app.get(
    '/api/v1/public/agency-by-code',
    { config: { public: true, tenantRequired: false, rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req) => mobile.agencyByCode(byCode.parse(req.query).code),
  );
  app.get(
    '/api/v1/public/app-version',
    { config: { public: true, tenantRequired: false } },
    async (req) => {
      const { platform, version: current } = version.parse(req.query);
      return mobile.versionStatus(platform, current);
    },
  );
}
