import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MAX_INVOICE_BYTES,
  agreementInputSchema,
  deletePaymentSchema,
  paymentInputSchema,
  stageParamSchema,
  amountChangeSchema,
  voidInputSchema,
} from '../bo/payment.js';
import { AppError } from '../exception/app-error.js';
import type { PaymentService } from '../service/payment-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const adminOnly = { roles: ['admin' as const] };
const clientParams = z.object({ profileId: z.uuid() });
const paymentParams = clientParams.extend({ paymentId: z.uuid() });
const stageParams = clientParams.extend({ stage: stageParamSchema });
const ownPaymentParams = z.object({ paymentId: z.uuid() });

/** An invoice goes out with headers that keep a browser from running or guessing at anything in it. */
function sendInvoice(reply: FastifyReply, file: { bytes: Buffer; mime: string; name: string }) {
  return reply
    .header('content-type', file.mime)
    .header(
      'content-disposition',
      `inline; filename="invoice"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    )
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'private, no-store')
    .send(file.bytes);
}

/**
 * Payments recorded in the office (see bo/payment.ts). Staff record them for the clients they look
 * after, a member reads their own ledger, and an admin cancels a mistaken payment. The invoice is the
 * request body (a PDF, JPG or PNG), like photos and CVs, whose parsers are already registered.
 */
export function registerPaymentController(
  app: FastifyInstance,
  payments: Pick<
    PaymentService,
    | 'ledger'
    | 'setAgreement'
    | 'record'
    | 'attachInvoice'
    | 'invoiceFile'
    | 'voidPayment'
    | 'deletePayment'
    | 'changeAmount'
    | 'changeAmount'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const upload = { rateLimit: { max: 20, timeWindow: 60000 } };

  // ---- a member's own payments ------------------------------------------------------------
  app.get('/api/v1/me/payments', { config: memberOnly }, async (req) =>
    payments.ledger(actor(req), { kind: 'own' }),
  );
  app.get('/api/v1/me/payments/:paymentId/invoice', { config: memberOnly }, async (req, reply) =>
    sendInvoice(
      reply,
      await payments.invoiceFile(
        actor(req),
        { kind: 'own' },
        ownPaymentParams.parse(req.params).paymentId,
      ),
    ),
  );

  // ---- staff, for the clients they look after ----------------------------------------------
  app.get('/api/v1/staff/clients/:profileId/payments', { config: staffOnly }, async (req) =>
    payments.ledger(actor(req), {
      kind: 'client',
      profileId: clientParams.parse(req.params).profileId,
    }),
  );

  app.put(
    '/api/v1/staff/clients/:profileId/agreements/:stage',
    { config: staffOnly },
    async (req) => {
      const params = stageParams.parse(req.params);
      return payments.setAgreement(
        actor(req),
        params.profileId,
        params.stage,
        agreementInputSchema.parse(req.body).amount,
        req.id,
      );
    },
  );

  app.post(
    '/api/v1/staff/clients/:profileId/payments',
    { config: { ...staffOnly, rateLimit: { max: 60, timeWindow: 60000 } } },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await payments.record(
            actor(req),
            clientParams.parse(req.params).profileId,
            paymentInputSchema.parse(req.body),
            req.id,
          ),
        ),
  );

  app.put(
    '/api/v1/staff/clients/:profileId/payments/:paymentId/invoice',
    { config: { ...staffOnly, ...upload }, bodyLimit: MAX_INVOICE_BYTES },
    async (req) => {
      const params = paymentParams.parse(req.params);
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
      const name = req.headers['x-file-name'];
      return payments.attachInvoice(
        actor(req),
        params.profileId,
        params.paymentId,
        req.body,
        String(req.headers['content-type'] ?? ''),
        typeof name === 'string' ? name : undefined,
        req.id,
      );
    },
  );

  app.get(
    '/api/v1/staff/clients/:profileId/payments/:paymentId/invoice',
    { config: staffOnly },
    async (req, reply) => {
      const params = paymentParams.parse(req.params);
      return sendInvoice(
        reply,
        await payments.invoiceFile(
          actor(req),
          { kind: 'client', profileId: params.profileId },
          params.paymentId,
        ),
      );
    },
  );

  app.post(
    '/api/v1/staff/clients/:profileId/payments/:paymentId/void',
    { config: adminOnly },
    async (req) => {
      const params = paymentParams.parse(req.params);
      return payments.voidPayment(
        actor(req),
        params.profileId,
        params.paymentId,
        voidInputSchema.parse(req.body).reason,
        req.id,
      );
    },
  );

  app.post(
    '/api/v1/staff/clients/:profileId/payments/:paymentId/delete',
    { config: adminOnly },
    async (req) => {
      const params = paymentParams.parse(req.params);
      return payments.deletePayment(
        actor(req),
        params.profileId,
        params.paymentId,
        deletePaymentSchema.parse(req.body).reason,
        req.id,
      );
    },
  );

  app.put(
    '/api/v1/staff/clients/:profileId/payments/:paymentId/amount',
    { config: adminOnly },
    async (req) => {
      const params = paymentParams.parse(req.params);
      return payments.changeAmount(
        actor(req),
        params.profileId,
        params.paymentId,
        amountChangeSchema.parse(req.body),
        req.id,
      );
    },
  );
}
