import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import type { AuthProcess } from '../process/auth-process.js';
import type { AccountAccessProcess } from '../process/account-access-process.js';
import type { GoogleAuthProcess } from '../process/google-auth-process.js';
import type { PhoneAuthProcess } from '../process/phone-auth-process.js';
import type { StaffInvitationProcess } from '../process/staff-invitation-process.js';
import type { RegistrationService } from '../service/registration-service.js';
import type { IdentityService } from '../service/identity-service.js';
import { bearerSchema, selfResponseSchema } from '../io/http/contracts.js';
import { accountResponse } from '../factory/account-response.js';
import { AppError } from '../exception/app-error.js';
import { registerAuthController } from './auth-controller.js';
import { registerProfileController } from './profile-controller.js';
import { registerCvController } from './cv-controller.js';
import {
  registerNotificationStream,
  type NotificationLive,
} from './notification-stream-controller.js';
import { registerPhotoController } from './photo-controller.js';
import { registerReviewController } from './review-controller.js';
import { registerClientController } from './client-controller.js';
import { registerGuardianController } from './guardian-controller.js';
import { registerClientLoginController } from './client-login-controller.js';
import type { ClientLoginProcess } from '../process/client-login-process.js';
import type { AccountDeletionProcess } from '../process/account-deletion-process.js';
import type { PushProcess } from '../process/push-process.js';
import { registerPaymentController } from './payment-controller.js';
import { registerMeetingController } from './meeting-controller.js';
import { registerVerificationController } from './verification-controller.js';
import { registerReportController } from './report-controller.js';
import { registerChatController } from './chat-controller.js';
import { registerMobileController } from './mobile-controller.js';
import { registerDeviceAuthController } from './device-auth-controller.js';
import type { MobileService } from '../service/mobile-service.js';
import { registerCandidateController } from './candidate-controller.js';
import { registerMatchController } from './match-controller.js';
import { registerConnectionController } from './connection-controller.js';
import type { ConnectionService } from '../service/connection-service.js';
import type { MatchProcess } from '../process/match-process.js';
import type { CandidateService } from '../service/candidate-service.js';
import { registerStaffController } from './staff-controller.js';
import type { ReviewProcess } from '../process/review-process.js';
import type { ClientService } from '../service/client-service.js';
import type { PhotoProcess } from '../process/photo-process.js';
import type { CvProcess } from '../process/cv-process.js';
import { fieldProblems } from '../io/http/validation.js';
import type { ProfileService } from '../service/profile-service.js';
import './context.js';
export interface AppDependencies {
  reviews: Pick<ReviewProcess, 'list' | 'pendingCount' | 'detail' | 'approve' | 'reject' | 'photo'>;
  clients: Pick<
    ClientService,
    | 'list'
    | 'detail'
    | 'create'
    | 'save'
    | 'submit'
    | 'requestEdit'
    | 'cancelPending'
    | 'changeStatus'
    | 'assign'
    | 'setStaffStatus'
    | 'handOver'
    | 'assignments'
    | 'listStaff'
  >;
  matches: Pick<MatchProcess, 'page' | 'detail' | 'photo'>;
  connections: Pick<
    ConnectionService,
    | 'send'
    | 'respond'
    | 'withdraw'
    | 'shareContact'
    | 'list'
    | 'notifications'
    | 'unreadCount'
    | 'markRead'
    | 'reviewQueue'
    | 'review'
    | 'reopen'
    | 'staffList'
    | 'staffRespond'
    | 'staffShareContact'
  >;
  candidates: Pick<
    CandidateService,
    'generate' | 'list' | 'settings' | 'saveSettings' | 'release' | 'remove'
  >;
  config: AppConfig;
  logger: Logger;
  redis: Redis;
  auth: Pick<
    AuthProcess,
    | 'login'
    | 'bootstrap'
    | 'authenticate'
    | 'refresh'
    | 'logout'
    | 'toDevice'
    | 'refreshDevice'
    | 'logoutDevice'
  >;
  /** Undefined when Google sign-in is not configured. */
  google?: Pick<
    GoogleAuthProcess,
    'start' | 'complete' | 'pending' | 'link' | 'pendingSignup' | 'signup'
  >;
  /** Undefined when no SMS sender is configured. */
  phone?: Pick<
    PhoneAuthProcess,
    'sendCode' | 'verifyCode' | 'pendingSignup' | 'signup' | 'sendAttachCode' | 'confirmAttach'
  >;
  registrations: Pick<RegistrationService, 'signInMethods'>;
  access: Pick<
    AccountAccessProcess,
    | 'startRegistration'
    | 'verifyEmail'
    | 'requestPasswordReset'
    | 'resetPassword'
    | 'sendReauthCode'
    | 'startAddEmail'
    | 'confirmAddEmail'
    | 'changePassword'
  >;
  invitations: Pick<
    StaffInvitationProcess,
    'invite' | 'resend' | 'list' | 'revoke' | 'preview' | 'accept' | 'create'
  >;
  /** Undefined in tests that do not need it. */
  guardians?: Parameters<typeof registerGuardianController>[1];
  clientLogins?: Pick<ClientLoginProcess, 'status' | 'grant' | 'revoke' | 'preview' | 'accept'>;
  /** Undefined in tests that do not need it. */
  deletions?: Pick<AccountDeletionProcess, 'request'>;
  /** Undefined in tests that do not need it. */
  push?: Pick<PushProcess, 'register' | 'unregister'>;
  /** Undefined in tests that do not need it. */
  payments?: Parameters<typeof registerPaymentController>[1];
  verification?: Parameters<typeof registerVerificationController>[1];
  meetings?: Parameters<typeof registerMeetingController>[1];
  /** Undefined in tests that do not need it. */
  reports?: Parameters<typeof registerReportController>[1];
  /** Undefined in tests that do not need it. */
  chats?: Parameters<typeof registerChatController>[1];
  /** Undefined in tests that do not need it. */
  mobile?: Pick<MobileService, 'agencyByCode' | 'versionStatus'>;
  identities: Pick<IdentityService, 'tenant'>;
  photos: Pick<PhotoProcess, 'list' | 'upload' | 'remove' | 'makePrimary' | 'image'>;
  /** Live notifications: who to hear about and the unread count to send. */
  live: NotificationLive;
  cvs: Pick<
    CvProcess,
    'state' | 'upload' | 'remove' | 'review' | 'file' | 'fileOfConnection' | 'infoOfConnection'
  >;
  profiles: Pick<ProfileService, 'get' | 'save' | 'submit' | 'requestEdit' | 'cancelPending'>;
  ready: () => Promise<void>;
}
export async function buildApp(deps: AppDependencies) {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 15000,
    connectionTimeout: 15000,
  });
  await app.register(cookie);
  await app.register(helmet, { referrerPolicy: { policy: 'no-referrer' } });
  await app.register(rateLimit, {
    redis: deps.redis,
    max: 120,
    timeWindow: 60000,
    skipOnError: false,
    keyGenerator: (req) => req.ip,
    nameSpace: 'matrimony:rate:',
  });
  app.decorateRequest('tenant', null);
  app.decorateRequest('principal', null);
  app.decorateRequest('canonicalOrigin', '');
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id).header('cache-control', 'no-store');
    if (req.routeOptions.config.tenantRequired === false) return;
    const host = req.headers.host?.toLowerCase();
    if (!host || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host))
      throw new AppError(400, 'HOST_INVALID');
    const hostname = host.split(':')[0]!;
    if (config.NODE_ENV === 'production' && host !== hostname)
      throw new AppError(400, 'HOST_INVALID');
    req.tenant = await deps.identities.tenant(hostname);
    req.canonicalOrigin = `${config.NODE_ENV === 'production' ? 'https' : 'http'}://${host}`;
    if (req.routeOptions.config.public === true) return;
    const parsed = bearerSchema.safeParse(req.headers.authorization);
    if (!parsed.success) throw new AppError(401, 'BEARER_TOKEN_REQUIRED');
    req.principal = await deps.auth.authenticate(req.tenant.id, parsed.data);
    const roles = req.routeOptions.config.roles;
    if (roles && !roles.includes(req.principal.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  });
  app.setErrorHandler((error, req, reply) => {
    const known = error instanceof AppError;
    const transport =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 0;
    const status = known
      ? error.status
      : error instanceof ZodError
        ? 400
        : transport >= 400 && transport < 500
          ? transport
          : 500;
    const code = known
      ? error.code
      : status === 400
        ? 'INVALID_REQUEST'
        : status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status === 415
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : status === 429
              ? 'RATE_LIMITED'
              : status < 500
                ? 'REQUEST_REJECTED'
                : 'INTERNAL_ERROR';
    if (status >= 500)
      req.log.error(
        { code, errorType: error instanceof Error ? error.name : 'Unknown' },
        'Request failed',
      );
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    // A pause (too many attempts, too many emails) says how long to wait.
    if (known && typeof error.details?.retryAfter === 'number')
      reply.header('retry-after', String(error.details.retryAfter));
    const details = known
      ? error.details
      : error instanceof ZodError
        ? { fields: fieldProblems(error) }
        : undefined;
    return reply
      .code(status)
      .send({ error: { code, requestId: req.id, ...(details && { details }) } });
  });
  app.get(
    '/health/live',
    { config: { public: true, tenantRequired: false, rateLimit: false } },
    async () => ({ status: 'ok' }),
  );
  app.get(
    '/health/ready',
    { config: { public: true, tenantRequired: false, rateLimit: false } },
    async (_req, reply) => {
      try {
        await deps.ready();
        return { status: 'ready' };
      } catch {
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );
  app.get('/api/v1/public/tenant', { config: { public: true } }, async (req) => ({
    id: req.tenant!.id,
    name: req.tenant!.name,
    locale: req.tenant!.locale,
    content: req.tenant!.publicConfig,
  }));
  app.get('/api/v1/me', { schema: { response: { 200: selfResponseSchema } } }, async (req) =>
    accountResponse(req.principal!),
  );
  registerAuthController(
    app,
    deps.auth,
    deps.google,
    deps.phone,
    deps.registrations,
    deps.access,
    deps.invitations,
    config,
  );
  registerProfileController(app, deps.profiles);
  registerPhotoController(app, deps.photos);
  registerCvController(app, deps.cvs);
  registerReviewController(app, deps.reviews);
  registerClientController(app, deps.clients);
  registerCandidateController(app, deps.candidates);
  registerMatchController(app, deps.matches);
  registerConnectionController(app, deps.connections);
  registerNotificationStream(app, deps.live);
  registerStaffController(app, deps.invitations);
  if (deps.clientLogins) registerClientLoginController(app, deps.clientLogins, config);
  if (deps.guardians) registerGuardianController(app, deps.guardians, config);
  if (deps.mobile) registerMobileController(app, deps.mobile);
  if (deps.payments) registerPaymentController(app, deps.payments);
  if (deps.verification) registerVerificationController(app, deps.verification);
  if (deps.meetings) registerMeetingController(app, deps.meetings);
  if (deps.reports) registerReportController(app, deps.reports);
  if (deps.chats) registerChatController(app, deps.chats);
  const pushDevices = deps.push;
  if (pushDevices) {
    const registration = z
      .object({
        platform: z.enum(['ios', 'android']),
        token: z.string().min(20).max(4096),
        locale: z.enum(['bn', 'en']).default('bn'),
      })
      .strict();
    // A phone registers after signing in. Any signed-in account may, staff included.
    app.post(
      '/api/v1/me/push-devices',
      { config: { rateLimit: { max: 30, timeWindow: 600000 } } },
      async (req, reply) => {
        await pushDevices.register(
          { agencyId: req.tenant!.id, accountId: req.principal!.id },
          registration.parse(req.body),
        );
        return reply.code(204).send();
      },
    );
    // And removes itself when the person signs out or turns notifications off.
    app.delete('/api/v1/me/push-devices', async (req, reply) => {
      const { token } = z
        .object({ token: z.string().min(20).max(4096) })
        .strict()
        .parse(req.body);
      await pushDevices.unregister(
        { agencyId: req.tenant!.id, accountId: req.principal!.id },
        token,
      );
      return reply.code(204).send();
    });
  }
  const deletions = deps.deletions;
  if (deletions)
    // Members only. The password is asked again, and attempts share the sign-in pause.
    app.post(
      '/api/v1/me/delete-account',
      {
        config: { roles: ['member'], rateLimit: { max: 5, timeWindow: 600000 } },
        schema: {
          response: {
            202: {
              type: 'object',
              additionalProperties: false,
              required: ['scheduledFor'],
              properties: { scheduledFor: { type: 'string' } },
            },
          },
        },
      },
      async (req, reply) => {
        const { password } = z
          .object({ password: z.string().min(1).max(1024) })
          .strict()
          .parse(req.body);
        const result = await deletions.request(
          { agencyId: req.tenant!.id, accountId: req.principal!.id },
          password,
          req.id,
        );
        return reply.code(202).send(result);
      },
    );
  registerDeviceAuthController(app, deps.auth, deps.phone, deps.access);
  return app;
}
