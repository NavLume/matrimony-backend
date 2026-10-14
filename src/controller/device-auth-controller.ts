import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthProcess } from '../process/auth-process.js';
import type { AccountAccessProcess } from '../process/account-access-process.js';
import type { PhoneAuthProcess } from '../process/phone-auth-process.js';
import { forgotPasswordInputSchema, loginInputSchema } from '../bo/credentials.js';
import {
  phoneSignupInputSchema,
  phoneStartInputSchema,
  phoneVerifyInputSchema,
} from '../bo/phone.js';
import { registrationInputSchema } from '../bo/registration.js';
import { AppError } from '../exception/app-error.js';
import { browserSecretSchema, codeSentResponseSchema } from '../io/http/contracts.js';

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
const statusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string' } },
} as const;
const signupRequiredSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'signupToken'],
  properties: { status: { type: 'string' }, signupToken: { type: 'string' } },
} as const;

/**
 * Signing in and registering for a mobile app. The same checks as the website's sign-in (the same
 * passwords, codes, pauses and disabled-account rules), but the answer carries a refresh token and no
 * cookie is set, because an app has no browser to keep one. With no cookie there is nothing for
 * another site to ride on, so these routes do not need the same-origin and CSRF rules the cookie
 * routes have.
 *
 * The refresh token changes every time it is used, and using an old one ends the session.
 *
 * Emailed links (confirm email, reset password, a client's login, a staff invitation) still open the
 * website's pages, which finish the step there; the person then signs in to the app. Opening them
 * inside the app needs links that open the app, which is a later step.
 */
export function registerDeviceAuthController(
  app: FastifyInstance,
  auth: Pick<AuthProcess, 'login' | 'toDevice' | 'refreshDevice' | 'logoutDevice'>,
  phone: Pick<PhoneAuthProcess, 'sendCode' | 'verifyCode' | 'signup'> | undefined,
  access: Pick<AccountAccessProcess, 'startRegistration' | 'requestPasswordReset'> | undefined,
) {
  const phoneOrFail = () => {
    if (!phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    return phone;
  };
  const accessOrFail = () => {
    if (!access) throw new AppError(404, 'NOT_AVAILABLE');
    return access;
  };
  const limit = { max: 10, timeWindow: 60000 };
  const slow = { max: 10, timeWindow: 600000 };

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
  // Registering by email: the same as the website's. A link is emailed that finishes it on the website.
  app.post(
    '/api/v1/auth/device/register',
    { config: { public: true, rateLimit: slow }, schema: { response: { 202: statusSchema } } },
    async (req, reply) => {
      await accessOrFail().startRegistration(
        { agencyId: req.tenant!.id, agencyName: req.tenant!.name, origin: req.canonicalOrigin },
        registrationInputSchema.parse(req.body),
      );
      return reply.code(202).send({ status: 'verification_sent' });
    },
  );
  app.post(
    '/api/v1/auth/device/password/forgot',
    { config: { public: true, rateLimit: slow }, schema: { response: { 202: statusSchema } } },
    async (req, reply) => {
      const { email } = forgotPasswordInputSchema.parse(req.body);
      await accessOrFail().requestPasswordReset(
        { agencyId: req.tenant!.id, agencyName: req.tenant!.name, origin: req.canonicalOrigin },
        email,
      );
      return reply.code(202).send({ status: 'reset_link_sent' });
    },
  );
  app.post(
    '/api/v1/auth/device/phone/start',
    {
      config: { public: true, rateLimit: slow },
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
  // A right code signs in the number's account (200). A number with no account answers 202 with a
  // signup token (valid for 10 minutes) to finish with /device/phone/signup.
  app.post(
    '/api/v1/auth/device/phone/verify',
    {
      config: { public: true, rateLimit: limit },
      schema: { response: { 200: deviceTokensSchema, 202: signupRequiredSchema } },
    },
    async (req, reply) => {
      const input = phoneVerifyInputSchema.parse(req.body);
      const outcome = await phoneOrFail().verifyCode(
        req.tenant!.id,
        input.phone,
        input.code,
        input.locale,
        input.purpose,
        req.id,
      );
      if (outcome.kind === 'signup')
        return reply.code(202).send({ status: 'signup_required', signupToken: outcome.pendingId });
      return auth.toDevice(req.tenant!.id, outcome);
    },
  );
  app.post(
    '/api/v1/auth/device/phone/signup',
    {
      config: { public: true, rateLimit: limit },
      schema: { response: { 200: deviceTokensSchema } },
    },
    async (req) => {
      const { signupToken, ...rest } = z
        .object({ signupToken: browserSecretSchema })
        .passthrough()
        .parse(req.body);
      const input = phoneSignupInputSchema.parse(rest);
      const started = await phoneOrFail().signup(req.tenant!.id, signupToken, input, req.id);
      return auth.toDevice(req.tenant!.id, started);
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
