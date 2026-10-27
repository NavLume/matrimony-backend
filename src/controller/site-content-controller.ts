import type { FastifyInstance } from 'fastify';
import { AppError } from '../exception/app-error.js';
import { z } from 'zod';
import {
  brandingSchema,
  gallerySchema,
  MAX_LOGO_BYTES,
  MAX_SITE_IMAGE_BYTES,
  siteContentSchema,
  siteImageSlotSchema,
  weddingDateSchema,
} from '../bo/site-content.js';
import type { SiteContentService } from '../service/site-content-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };

/** The public site's words, edited by the agency admin (see bo/site-content.ts). */
export function registerSiteContentController(
  app: FastifyInstance,
  content: Pick<
    SiteContentService,
    | 'get'
    | 'update'
    | 'setBranding'
    | 'setLogo'
    | 'removeLogo'
    | 'setImage'
    | 'removeImage'
    | 'addGalleryImage'
    | 'setGallery'
    | 'removeGalleryImage'
    | 'setStoryPhoto'
    | 'removeStoryPhoto'
    | 'setStoryWeddingDate'
    | 'storyPhotoFile'
    | 'storyPhotoForAdmin'
    | 'logoFile'
    | 'preview'
    | 'readPreview'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/admin/site-content', { config: adminOnly }, async (req) =>
    content.get(actor(req)),
  );

  app.put(
    '/api/v1/admin/site-content',
    { config: { ...adminOnly, rateLimit: { max: 30, timeWindow: 60000 } } },
    async (req, reply) => {
      await content.update(actor(req), siteContentSchema.parse(req.body ?? {}), req.id);
      return reply.code(204).send();
    },
  );

  const write = { rateLimit: { max: 30, timeWindow: 60000 } };
  app.put('/api/v1/admin/branding', { config: { ...adminOnly, ...write } }, async (req, reply) => {
    await content.setBranding(actor(req), brandingSchema.parse(req.body ?? {}), req.id);
    return reply.code(204).send();
  });
  // The logo is the request body itself, like a photo; its real type is checked when it is processed.
  app.put(
    '/api/v1/admin/branding/logo',
    {
      config: { ...adminOnly, rateLimit: { max: 10, timeWindow: 60000 } },
      bodyLimit: MAX_LOGO_BYTES,
    },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
      return { logoUrl: await content.setLogo(actor(req), req.body, req.id) };
    },
  );
  app.delete(
    '/api/v1/admin/branding/logo',
    { config: { ...adminOnly, ...write } },
    async (req, reply) => {
      await content.removeLogo(actor(req), req.id);
      return reply.code(204).send();
    },
  );

  // The home page's pictures: the hero, about and call-to-action ones by name, and the gallery's one by one.
  const imageRoute = { config: { ...adminOnly, rateLimit: { max: 20, timeWindow: 60000 } } };
  const imageBody = { ...imageRoute, bodyLimit: MAX_SITE_IMAGE_BYTES };
  app.put('/api/v1/admin/site-images/:slot', imageBody, async (req) => {
    const slot = siteImageSlotSchema.safeParse((req.params as { slot: string }).slot);
    if (!slot.success) throw new AppError(404, 'NOT_FOUND');
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
    return { url: await content.setImage(actor(req), slot.data, req.body, req.id) };
  });
  app.delete('/api/v1/admin/site-images/:slot', imageRoute, async (req, reply) => {
    const slot = siteImageSlotSchema.safeParse((req.params as { slot: string }).slot);
    if (!slot.success) throw new AppError(404, 'NOT_FOUND');
    await content.removeImage(actor(req), slot.data, req.id);
    return reply.code(204).send();
  });
  app.post('/api/v1/admin/gallery', imageBody, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
    return reply
      .code(201)
      .send({ url: await content.addGalleryImage(actor(req), req.body, req.id) });
  });
  app.put('/api/v1/admin/gallery', imageRoute, async (req, reply) => {
    await content.setGallery(
      actor(req),
      z
        .object({ gallery: gallerySchema })
        .strict()
        .parse(req.body ?? {}).gallery,
      req.id,
    );
    return reply.code(204).send();
  });
  app.delete('/api/v1/admin/gallery/:file', imageRoute, async (req, reply) => {
    await content.removeGalleryImage(actor(req), (req.params as { file: string }).file, req.id);
    return reply.code(204).send();
  });

  // A success story's couple photo and wedding date (the story itself is published from Reports).
  const storyParams = z.object({ storyId: z.uuid() });
  app.put('/api/v1/admin/success-stories/:storyId/photo', imageBody, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
    await content.setStoryPhoto(
      actor(req),
      storyParams.parse(req.params).storyId,
      req.body,
      req.id,
    );
    return reply.code(204).send();
  });
  app.get(
    '/api/v1/admin/success-stories/:storyId/photo',
    { config: adminOnly },
    async (req, reply) => {
      const bytes = await content.storyPhotoForAdmin(
        actor(req),
        storyParams.parse(req.params).storyId,
      );
      if (!bytes) throw new AppError(404, 'NOT_FOUND');
      return reply
        .header('content-type', 'image/webp')
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(bytes);
    },
  );
  app.delete('/api/v1/admin/success-stories/:storyId/photo', imageRoute, async (req, reply) => {
    await content.removeStoryPhoto(actor(req), storyParams.parse(req.params).storyId, req.id);
    return reply.code(204).send();
  });
  app.put('/api/v1/admin/success-stories/:storyId/wedding-date', imageRoute, async (req, reply) => {
    await content.setStoryWeddingDate(
      actor(req),
      storyParams.parse(req.params).storyId,
      weddingDateSchema.parse(req.body ?? {}).weddingDate,
      req.id,
    );
    return reply.code(204).send();
  });
  app.get('/api/v1/public/story-photos/:file', { config: { public: true } }, async (req, reply) => {
    const { file } = req.params as { file: string };
    const bytes = await content.storyPhotoFile(req.tenant!.id, file);
    if (!bytes) throw new AppError(404, 'NOT_FOUND');
    // Not cached for long: hiding the story must make the photo vanish.
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  });

  // The logo of the agency for the request's host. The file name is a random id, so it can be cached for good.
  app.get('/api/v1/public/branding/:file', { config: { public: true } }, async (req, reply) => {
    const { file } = req.params as { file: string };
    const bytes = await content.logoFile(req.tenant!.id, file);
    if (!bytes) throw new AppError(404, 'NOT_FOUND');
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  });

  // A draft of the public site to look at before saving; kept for 30 minutes under a random link.
  const previewSchema = z
    .object({ branding: brandingSchema.optional(), content: siteContentSchema.optional() })
    .strict();
  app.post(
    '/api/v1/admin/site-preview',
    { config: { ...adminOnly, ...write }, bodyLimit: 400 * 1024 },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await content.preview(
            actor(req),
            { name: req.tenant!.name, locale: req.tenant!.locale as 'bn' | 'en' },
            previewSchema.parse(req.body ?? {}),
          ),
        ),
  );
  app.get('/api/v1/public/preview/:id', { config: { public: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const preview = await content.readPreview(req.tenant!.id, id);
    if (!preview) throw new AppError(404, 'PREVIEW_NOT_FOUND');
    return {
      id: req.tenant!.id,
      name: preview.name,
      locale: preview.locale,
      content: preview.content,
    };
  });
}
