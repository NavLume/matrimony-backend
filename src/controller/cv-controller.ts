import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CV_TYPE, MAX_CV_BYTES, reviewCvSchema } from '../bo/cv.js';
import { AppError } from '../exception/app-error.js';
import { cvInfoResponse, cvStateResponse } from '../factory/cv-response.js';
import type { CvProcess } from '../process/cv-process.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const profileParams = z.object({ profileId: z.uuid() });
const memberOrGuardian = { roles: ['member' as const, 'guardian' as const] };
const candidateParams = z.object({ candidateId: z.uuid() });
const whichQuery = z.object({ which: z.enum(['current', 'replacement']).default('current') });

/**
 * The body must be a PDF by its declared type as well as its bytes. Other upload types are parsed
 * by other routes' parsers (photos), so the type is checked here too.
 */
const pdfBody = (req: { body: unknown; headers: Record<string, unknown> }): Buffer => {
  const declared = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!Buffer.isBuffer(req.body) || !declared.startsWith(CV_TYPE)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  return req.body;
};

/** A CV file goes out with headers that keep a browser from running or guessing at anything in it. */
function sendPdf(reply: FastifyReply, file: { bytes: Buffer; fileName: string }) {
  return reply
    .header('content-type', CV_TYPE)
    .header(
      'content-disposition',
      `inline; filename="cv.pdf"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    )
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'private, no-store')
    .send(file.bytes);
}

/**
 * A profile's CV. A member keeps their own; staff keep one for a client they run and approve what a
 * member uploaded; a connected member may read the other person's. The file itself is the request
 * body (a PDF), like photos.
 */
export function registerCvController(
  app: FastifyInstance,
  cvs: Pick<
    CvProcess,
    'state' | 'upload' | 'remove' | 'review' | 'file' | 'fileOfConnection' | 'infoOfConnection'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const fileName = (headers: Record<string, unknown>) =>
    typeof headers['x-file-name'] === 'string' ? headers['x-file-name'] : undefined;
  const upload = { rateLimit: { max: 10, timeWindow: 60000 } };

  app.addContentTypeParser(
    CV_TYPE,
    { parseAs: 'buffer', bodyLimit: MAX_CV_BYTES },
    (_req, body, done) => done(null, body),
  );

  // ---- a member's own CV ------------------------------------------------------------------
  app.get('/api/v1/me/profile/cv', { config: memberOnly }, async (req) =>
    cvStateResponse(await cvs.state(actor(req), { kind: 'own' })),
  );

  app.put(
    '/api/v1/me/profile/cv',
    { config: { ...memberOnly, ...upload }, bodyLimit: MAX_CV_BYTES },
    async (req) => {
      return cvStateResponse(
        await cvs.upload(actor(req), { kind: 'own' }, pdfBody(req), fileName(req.headers), req.id),
      );
    },
  );

  app.delete('/api/v1/me/profile/cv', { config: memberOnly }, async (req) =>
    cvStateResponse(await cvs.remove(actor(req), { kind: 'own' }, req.id)),
  );

  app.get('/api/v1/me/profile/cv/file', { config: memberOnly }, async (req, reply) =>
    sendPdf(reply, await cvs.file(actor(req), { kind: 'own' }, whichQuery.parse(req.query).which)),
  );

  // ---- a connected person's CV --------------------------------------------------------------
  app.get('/api/v1/me/matches/:candidateId/cv', { config: memberOrGuardian }, async (req) =>
    cvInfoResponse(
      await cvs.infoOfConnection(actor(req), candidateParams.parse(req.params).candidateId),
    ),
  );

  app.get(
    '/api/v1/me/matches/:candidateId/cv/file',
    { config: memberOrGuardian },
    async (req, reply) =>
      sendPdf(
        reply,
        await cvs.fileOfConnection(actor(req), candidateParams.parse(req.params).candidateId),
      ),
  );

  // ---- staff, for the clients they look after -------------------------------------------------
  app.get('/api/v1/staff/clients/:profileId/cv', { config: staffOnly }, async (req) =>
    cvStateResponse(
      await cvs.state(actor(req), {
        kind: 'client',
        profileId: profileParams.parse(req.params).profileId,
      }),
    ),
  );

  app.put(
    '/api/v1/staff/clients/:profileId/cv',
    { config: { ...staffOnly, ...upload }, bodyLimit: MAX_CV_BYTES },
    async (req) => {
      const { profileId } = profileParams.parse(req.params);
      return cvStateResponse(
        await cvs.upload(
          actor(req),
          { kind: 'client', profileId },
          pdfBody(req),
          fileName(req.headers),
          req.id,
        ),
      );
    },
  );

  app.delete('/api/v1/staff/clients/:profileId/cv', { config: staffOnly }, async (req) =>
    cvStateResponse(
      await cvs.remove(
        actor(req),
        { kind: 'client', profileId: profileParams.parse(req.params).profileId },
        req.id,
      ),
    ),
  );

  app.get('/api/v1/staff/clients/:profileId/cv/file', { config: staffOnly }, async (req, reply) =>
    sendPdf(
      reply,
      await cvs.file(
        actor(req),
        { kind: 'client', profileId: profileParams.parse(req.params).profileId },
        whichQuery.parse(req.query).which,
      ),
    ),
  );

  app.post('/api/v1/staff/clients/:profileId/cv/review', { config: staffOnly }, async (req) => {
    const body = reviewCvSchema.parse(req.body);
    return cvStateResponse(
      await cvs.review(
        actor(req),
        profileParams.parse(req.params).profileId,
        body.decision === 'approve',
        body.notes ?? null,
        req.id,
      ),
    );
  });
}
