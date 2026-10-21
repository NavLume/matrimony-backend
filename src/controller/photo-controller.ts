import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, photoPrivacySchema } from '../bo/photo.js';
import { AppError } from '../exception/app-error.js';
import { photoListResponse } from '../factory/photo-response.js';
import type { PhotoProcess } from '../process/photo-process.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const clientParams = z.object({ profileId: z.uuid(), photoId: z.uuid().optional() });
const params = z.object({ photoId: z.uuid() });
const imageQuery = z.object({ size: z.enum(['full', 'thumb']).default('full') });

/**
 * A member's own photos (member-only routes) and a client's photos for the staff who look after them (admin or
 * agent), whether the client has a login or not.
 */
export function registerPhotoController(
  app: FastifyInstance,
  photos: Pick<PhotoProcess, 'list' | 'upload' | 'remove' | 'makePrimary' | 'image' | 'setPrivacy'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  // The picture is the request body itself, not a form: that needs no extra parser library and
  // is the simplest thing to bound. Only image types are accepted; the file's real type is
  // checked again when it is processed.
  app.addContentTypeParser(
    [...UPLOAD_TYPES],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/api/v1/me/profile/photos', { config: memberOnly }, async (req) =>
    photoListResponse(await photos.list(actor(req))),
  );

  app.post(
    '/api/v1/me/profile/photos',
    {
      // A tighter limit than the general one: each upload is real work for the server.
      config: { ...memberOnly, rateLimit: { max: 20, timeWindow: 60000 } },
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
      const list = await photos.upload(actor(req), req.body, req.id);
      return reply.code(201).send(photoListResponse(list));
    },
  );

  app.put('/api/v1/me/profile/photos-privacy', { config: memberOnly }, async (req) =>
    photoListResponse(
      await photos.setPrivacy(actor(req), photoPrivacySchema.parse(req.body).privacy, req.id),
    ),
  );

  app.put('/api/v1/me/profile/photos/:photoId/primary', { config: memberOnly }, async (req) =>
    photoListResponse(await photos.makePrimary(actor(req), params.parse(req.params).photoId)),
  );

  app.delete('/api/v1/me/profile/photos/:photoId', { config: memberOnly }, async (req) =>
    photoListResponse(await photos.remove(actor(req), params.parse(req.params).photoId, req.id)),
  );

  app.get(
    '/api/v1/me/profile/photos/:photoId/image',
    { config: memberOnly },
    async (req, reply) => {
      const { photoId } = params.parse(req.params);
      const { size } = imageQuery.parse(req.query);
      const bytes = await photos.image(actor(req), photoId, size);
      // Private to this member's browser, which may keep it: a photo's picture never changes.
      return reply
        .header('content-type', 'image/webp')
        .header('cache-control', 'private, max-age=3600')
        .send(bytes);
    },
  );

  // ---- a client's photos, for staff -------------------------------------------------------------
  const client = (req: { params: unknown }) => ({
    kind: 'client' as const,
    profileId: clientParams.parse(req.params).profileId,
  });

  app.get('/api/v1/staff/clients/:profileId/photos', { config: staffOnly }, async (req) =>
    photoListResponse(await photos.list(actor(req), client(req))),
  );

  app.post(
    '/api/v1/staff/clients/:profileId/photos',
    {
      config: { ...staffOnly, rateLimit: { max: 30, timeWindow: 60000 } },
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
      const list = await photos.upload(actor(req), req.body, req.id, client(req));
      return reply.code(201).send(photoListResponse(list));
    },
  );

  app.put('/api/v1/staff/clients/:profileId/photos-privacy', { config: staffOnly }, async (req) =>
    photoListResponse(
      await photos.setPrivacy(
        actor(req),
        photoPrivacySchema.parse(req.body).privacy,
        req.id,
        client(req),
      ),
    ),
  );

  app.put(
    '/api/v1/staff/clients/:profileId/photos/:photoId/primary',
    { config: staffOnly },
    async (req) =>
      photoListResponse(
        await photos.makePrimary(actor(req), params.parse(req.params).photoId, client(req)),
      ),
  );

  app.delete(
    '/api/v1/staff/clients/:profileId/photos/:photoId',
    { config: staffOnly },
    async (req) =>
      photoListResponse(
        await photos.remove(actor(req), params.parse(req.params).photoId, req.id, client(req)),
      ),
  );

  app.get(
    '/api/v1/staff/clients/:profileId/photos/:photoId/image',
    { config: staffOnly },
    async (req, reply) => {
      const { photoId } = params.parse(req.params);
      const { size } = imageQuery.parse(req.query);
      const bytes = await photos.image(actor(req), photoId, size, client(req));
      return reply
        .header('content-type', 'image/webp')
        .header('cache-control', 'private, max-age=3600')
        .send(bytes);
    },
  );
}
