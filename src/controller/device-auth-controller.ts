import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthProcess } from '../process/auth-process.js';
import type { PhoneAuthProcess } from '../process/phone-auth-process.js';
import { loginInputSchema } from '../bo/credentials.js';
import { phoneStartInputSchema, phoneVerifyInputSchema } from '../bo/phone.js';
import { AppError } from '../exception/app-error.js';
import { codeSentResponseSchema } from '../io/http/contracts.js';

const refreshInputSchema = z
  .object({ refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/) })
  .strict();
const deviceTokensSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['accessToken', 'refreshToken', 'expiresIn'],
  properties: {
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
    expiresIn: { type: 'integer' },
  },
} as const;

/**
 * Signing in for a mobile app. The same checks as the website's sign-in (the same passwords, codes,
 * pauses and disabled-account rules), but the answer carries a refresh token and no cookie is set,
 * because an app has no browser to keep one. With no cookie there is nothing for another site to
 * ride on, so these routes do not need the same-origin and CSRF rules the cookie routes have.
 *
 * The refresh token changes every time it is used, and using an old one ends the session.
 */
export function registerDeviceAuthController(
  app: FastifyInstance,
  auth: Pick<AuthProcess, 'login' | 'toDevice' | 'refreshDevice' | 'logoutDevice'>,
  phone: Pick<PhoneAuthProcess, 'sendCode' | 'verifyCode'> | undefined,
) {
  const phoneOrFail = () => {
    if (!phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    return phone;
  };
  const limit = { max: 10, timeWindow: 60000 };

  app.post(
    '/api/v1/auth/device/login',
    {
      config: { public: true, rateLimit: limit },
      schema: { response: { 200: deviceTokensSchema } },
    },
    async (req) => {
      const started = await auth.login(req.tenant!.id, loginInputSchema.parse(req.body), req.id);
      return auth.toDevice(req.tenant!.id, started);
    },
  );
  app.post(
    '/api/v1/auth/device/phone/start',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 202: codeSentResponseSchema } },
    },
    async (req, reply) => {
      const input = phoneStartInputSchema.parse(req.body);
      const sent = await phoneOrFail().sendCode(
        { agencyId: req.tenant!.id, agencyName: req.tenant!.name },
        input.phone,
        input.locale,
        input.purpose,
      );
      return reply.code(202).send({ status: 'code_sent', ...sent });
    },
  );
  // Registering by phone inside the app is a later step: a number with no account is told so.
  app.post(
    '/api/v1/auth/device/phone/verify',
    {
      config: { public: true, rateLimit: limit },
      schema: { response: { 200: deviceTokensSchema } },
    },
    async (req) => {
      const input = phoneVerifyInputSchema.parse(req.body);
      const outcome = await phoneOrFail().verifyCode(
        req.tenant!.id,
        input.phone,
        input.code,
        input.locale,
        input.purpose,
        req.id,
      );
      if (outcome.kind !== 'session') throw new AppError(409, 'REGISTRATION_REQUIRED');
      return auth.toDevice(req.tenant!.id, outcome);
    },
  );
  app.post(
    '/api/v1/auth/device/refresh',
    {
      config: { public: true, rateLimit: limit },
      schema: { response: { 200: deviceTokensSchema } },
    },
    async (req) => {
      const { refreshToken } = refreshInputSchema.parse(req.body);
      return auth.refreshDevice(req.tenant!.id, refreshToken, req.id);
    },
  );
  app.post('/api/v1/auth/device/logout', { config: { public: true } }, async (req, reply) => {
    const { refreshToken } = refreshInputSchema.parse(req.body);
    await auth.logoutDevice(req.tenant!.id, refreshToken, req.id);
    return reply.code(204).send();
  });
}
