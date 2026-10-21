import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MAX_DOCUMENT_BYTES,
  approveInputSchema,
  checksInputSchema,
  documentTypeSchema,
  rejectInputSchema,
} from '../bo/verification.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { VerificationService } from '../service/verification-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const adminOnly = { roles: ['admin' as const] };
const clientParams = z.object({ profileId: z.uuid() });

/** A document goes out with headers that keep a browser from running or guessing at anything in it. */
function sendDocument(reply: FastifyReply, file: { bytes: Buffer; mime: string }) {
  return reply
    .header('content-type', file.mime)
    .header('content-disposition', 'inline; filename="document"')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'private, no-store')
    .send(file.bytes);
}

/**
 * Identity verification (see bo/verification.ts). A member sends a document for their own profile,
 * or staff send one for a client they look after; staff decide. The document is the request body
 * (a PDF, JPG or PNG), like photos and CVs, whose parsers are already registered, and its kind comes
 * in the X-Document-Type header.
 */
export function registerVerificationController(
  app: FastifyInstance,
  verification: Pick<
    VerificationService,
    | 'state'
    | 'submit'
    | 'withdraw'
    | 'approve'
    | 'updateChecks'
    | 'reject'
    | 'revoke'
    | 'file'
    | 'waiting'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const upload = { rateLimit: { max: 10, timeWindow: 60000 } };
  const documentOf = (req: { body: unknown; headers: Record<string, unknown> }) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
    const kind = documentTypeSchema.safeParse(req.headers['x-document-type']);
    if (!kind.success)
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'documentType', code: 'invalidOption' }],
      });
    return { bytes: req.body, docType: kind.data, mime: String(req.headers['content-type'] ?? '') };
  };

  // ---- a member's own verification ---------------------------------------------------------
  app.get('/api/v1/me/verification', { config: memberOnly }, async (req) =>
    verification.state(actor(req), { kind: 'own' }),
  );
  app.put(
    '/api/v1/me/verification',
    { config: { ...memberOnly, ...upload }, bodyLimit: MAX_DOCUMENT_BYTES },
    async (req) => {
      const doc = documentOf(req);
      return verification.submit(
        actor(req),
        { kind: 'own' },
        doc.docType,
        doc.bytes,
        doc.mime,
        req.id,
      );
    },
  );
  app.delete('/api/v1/me/verification', { config: memberOnly }, async (req) =>
    verification.withdraw(actor(req), { kind: 'own' }, req.id),
  );

  // ---- staff ------------------------------------------------------------------------------
  app.get('/api/v1/staff/verifications', { config: staffOnly }, async (req) => ({
    items: await verification.waiting(actor(req)),
  }));
  app.get('/api/v1/staff/clients/:profileId/verification', { config: staffOnly }, async (req) =>
    verification.state(actor(req), {
      kind: 'client',
      profileId: clientParams.parse(req.params).profileId,
    }),
  );
  app.put(
    '/api/v1/staff/clients/:profileId/verification',
    { config: { ...staffOnly, ...upload }, bodyLimit: MAX_DOCUMENT_BYTES },
    async (req) => {
      const doc = documentOf(req);
      return verification.submit(
        actor(req),
        { kind: 'client', profileId: clientParams.parse(req.params).profileId },
        doc.docType,
        doc.bytes,
        doc.mime,
        req.id,
      );
    },
  );
  app.delete('/api/v1/staff/clients/:profileId/verification', { config: staffOnly }, async (req) =>
    verification.withdraw(
      actor(req),
      { kind: 'client', profileId: clientParams.parse(req.params).profileId },
      req.id,
    ),
  );
  app.get(
    '/api/v1/staff/clients/:profileId/verification/document',
    { config: staffOnly },
    async (req, reply) =>
      sendDocument(
        reply,
        await verification.file(actor(req), clientParams.parse(req.params).profileId, req.id),
      ),
  );
  app.post(
    '/api/v1/staff/clients/:profileId/verification/approve',
    { config: staffOnly },
    async (req) =>
      verification.approve(
        actor(req),
        clientParams.parse(req.params).profileId,
        approveInputSchema.parse(req.body ?? {}).checks,
        req.id,
      ),
  );
  app.put(
    '/api/v1/staff/clients/:profileId/verification/checks',
    { config: staffOnly },
    async (req) =>
      verification.updateChecks(
        actor(req),
        clientParams.parse(req.params).profileId,
        checksInputSchema.parse(req.body).checks,
        req.id,
      ),
  );
  app.post(
    '/api/v1/staff/clients/:profileId/verification/reject',
    { config: staffOnly },
    async (req) =>
      verification.reject(
        actor(req),
        clientParams.parse(req.params).profileId,
        rejectInputSchema.parse(req.body).note,
        req.id,
      ),
  );
  app.post(
    '/api/v1/staff/clients/:profileId/verification/revoke',
    { config: adminOnly },
    async (req) =>
      verification.revoke(actor(req), clientParams.parse(req.params).profileId, req.id),
  );
}
