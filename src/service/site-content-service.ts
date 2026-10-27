import { randomBytes, randomUUID } from 'node:crypto';
import { MAX_GALLERY_IMAGES, parsePublicConfig, type PublicConfig } from '../bo/public-config.js';
import {
  LOGO_FILE,
  MAX_LOGO_BYTES,
  MAX_SITE_IMAGE_BYTES,
  SITE_IMAGE_FILE,
  STORY_PHOTO_FILE,
  type BrandingInput,
  type SiteContent,
  type SiteContentInput,
  type SiteImageSlot,
} from '../bo/site-content.js';
import type { StoredPreview } from '../cache/repository/preview-repository.js';
import { processLogo, processSiteImage } from '../security/image-processor.js';
import type { FileStorage } from '../storage/service/file-storage.js';
import type { SiteContentDbService } from '../db/service/site-content-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/** The most stories the public site shows: the published ones first, then any the operator typed in. */
const MAX_STORIES = 12;

/** Where a success story's couple photo is served from (only while the story is published). */
const STORY_PHOTO_PATH = '/api/v1/public/story-photos/';

/** How long a draft can be looked at before it is saved, in seconds. */
const PREVIEW_SECONDS = 30 * 60;

/** Where a stored logo is served from. */
const LOGO_PATH = '/api/v1/public/branding/';

/**
 * The words of the public site (see bo/site-content.ts). The agency admin reads and changes them; the
 * public site is served with the stories the admin published added to them.
 */
export class SiteContentService {
  constructor(
    private readonly db: Pick<
      SiteContentDbService,
      | 'readConfig'
      | 'publishedStories'
      | 'update'
      | 'setStoryDetails'
      | 'isPublishedPhoto'
      | 'storyPhotoFile'
    >,
    private readonly storage: Pick<FileStorage, 'put' | 'get' | 'delete'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly previews?: {
      put(agencyId: string, id: string, preview: StoredPreview, ttl: number): Promise<void>;
      get(agencyId: string, id: string): Promise<StoredPreview | null>;
    },
  ) {}

  /** The public content with the published success stories (newest first) put in front of any typed by hand. */
  async withStories(agencyId: string, content: PublicConfig): Promise<PublicConfig> {
    const published = await this.db.publishedStories(agencyId, MAX_STORIES);
    if (published.length === 0) return content;
    const fromMatches = parsePublicConfig({
      successStories: published.map((story) => ({
        names: story.names,
        story: story.story ?? undefined,
        year: story.year ?? undefined,
        photoUrl: story.photoFile ? `${STORY_PHOTO_PATH}${story.photoFile}` : undefined,
        weddingDate: story.weddingDate ?? undefined,
      })),
    }).successStories;
    return {
      ...content,
      successStories: [...fromMatches, ...content.successStories].slice(0, MAX_STORIES),
    };
  }

  async get(actor: ProfileActor): Promise<SiteContent> {
    this.adminOnly(actor);
    const { config, published, agencyName } = await this.db.readConfig(actor.agencyId);
    const parsed = parsePublicConfig(config);
    return {
      branding: {
        name: parsed.name ?? agencyName,
        primaryColor: parsed.branding?.primaryColor,
        accentColor: parsed.branding?.accentColor,
        theme: parsed.branding?.theme,
        logoUrl: parsed.branding?.logoUrl,
      },
      contact: parsed.contact ?? {},
      home: parsed.home ?? {},
      auth: parsed.auth ?? {},
      about: parsed.about,
      images: {
        hero: parsed.images?.hero,
        about: parsed.images?.about,
        cta: parsed.images?.cta,
        gallery: parsed.images?.gallery ?? [],
      },
      branches: parsed.branches,
      publishedStories: published,
    };
  }

  async update(actor: ProfileActor, input: SiteContentInput, correlationId: string) {
    this.adminOnly(actor);
    await this.db.update(
      actor.agencyId,
      (current) => mergeContent(current, input),
      this.event(actor, correlationId),
    );
  }

  /** The name and main colour. An empty one is removed, so the agency's own name and the platform colour apply. */
  async setBranding(actor: ProfileActor, input: BrandingInput, correlationId: string) {
    this.adminOnly(actor);
    await this.db.update(
      actor.agencyId,
      (current) => mergeBranding(current, input),
      this.event(actor, correlationId),
    );
  }

  /**
   * Keeps a draft for a short time so the admin can look at the public site as it would be, without
   * saving anything. The draft is applied to the stored content with the same rules as a save, and the
   * published stories are added as for a visitor. Returns the link's id.
   */
  async preview(
    actor: ProfileActor,
    tenant: { name: string; locale: 'bn' | 'en' },
    draft: { branding?: BrandingInput; content?: SiteContentInput },
  ): Promise<{ id: string }> {
    this.adminOnly(actor);
    if (!this.previews) throw new AppError(503, 'PREVIEW_UNAVAILABLE');
    const { config } = await this.db.readConfig(actor.agencyId);
    let next = config;
    if (draft.content) next = mergeContent(next, draft.content);
    if (draft.branding) next = mergeBranding(next, draft.branding);
    const content = await this.withStories(actor.agencyId, parsePublicConfig(next));
    const id = randomBytes(16).toString('hex');
    await this.previews.put(
      actor.agencyId,
      id,
      { name: parsePublicConfig(next).name ?? tenant.name, locale: tenant.locale, content },
      PREVIEW_SECONDS,
    );
    return { id };
  }

  /** A draft by its link, for the agency of the request. Null once it has expired or never existed. */
  async readPreview(agencyId: string, id: string): Promise<StoredPreview | null> {
    if (!this.previews || !/^[0-9a-f]{32}$/.test(id)) return null;
    return this.previews.get(agencyId, id);
  }

  /** Replaces the logo: the picture is decoded and written again as a small WebP, so nothing else in the file survives. */
  async setLogo(actor: ProfileActor, bytes: Buffer, correlationId: string): Promise<string> {
    this.adminOnly(actor);
    if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE');
    const image = await processLogo(bytes);
    const file = `logo-${this.newId()}.webp`;
    const url = `${LOGO_PATH}${file}`;
    await this.storage.put(this.key(actor.agencyId, file), image, 'image/webp');
    let previous: string | undefined;
    try {
      await this.db.update(
        actor.agencyId,
        (current) => {
          const branding = { ...asObject(current.branding) };
          previous = typeof branding.logoUrl === 'string' ? branding.logoUrl : undefined;
          branding.logoUrl = url;
          return { ...current, branding };
        },
        this.event(actor, correlationId),
      );
    } catch (error) {
      await this.storage.delete(this.key(actor.agencyId, file)).catch(() => undefined);
      throw error;
    }
    await this.deleteStored(actor.agencyId, previous);
    return url;
  }

  async removeLogo(actor: ProfileActor, correlationId: string) {
    this.adminOnly(actor);
    let previous: string | undefined;
    await this.db.update(
      actor.agencyId,
      (current) => {
        const branding = { ...asObject(current.branding) };
        previous = typeof branding.logoUrl === 'string' ? branding.logoUrl : undefined;
        delete branding.logoUrl;
        const next = { ...current };
        if (Object.keys(branding).length > 0) next.branding = branding;
        else delete next.branding;
        return next;
      },
      this.event(actor, correlationId),
    );
    await this.deleteStored(actor.agencyId, previous);
  }

  /** A stored logo or home-page picture for the public site, or null. Only names this service wrote are looked up. */
  async logoFile(agencyId: string, file: string): Promise<Buffer | null> {
    if (!LOGO_FILE.test(file) && !SITE_IMAGE_FILE.test(file)) return null;
    return this.storage.get(this.key(agencyId, file));
  }

  /**
   * The couple photo of a success story. Admin only; the couple's agreement to the story covers it. The picture is
   * written again as a WebP like every site image. It is shown only while the story is published.
   */
  async setStoryPhoto(
    actor: ProfileActor,
    storyId: string,
    bytes: Buffer,
    correlationId: string,
  ): Promise<void> {
    this.adminOnly(actor);
    if (bytes.length === 0 || bytes.length > MAX_SITE_IMAGE_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE');
    const image = await processSiteImage(bytes);
    const file = `story-${this.newId()}.webp`;
    const key = this.storyKey(actor.agencyId, file);
    await this.storage.put(key, image, 'image/webp');
    let result;
    try {
      result = await this.db.setStoryDetails(
        actor.agencyId,
        storyId,
        { photoFile: file },
        this.event(actor, correlationId),
      );
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    if (!result) {
      await this.storage.delete(key).catch(() => undefined);
      throw new AppError(404, 'STORY_NOT_FOUND');
    }
    if (result.previous)
      await this.storage
        .delete(this.storyKey(actor.agencyId, result.previous))
        .catch(() => undefined);
  }

  async removeStoryPhoto(actor: ProfileActor, storyId: string, correlationId: string) {
    this.adminOnly(actor);
    const result = await this.db.setStoryDetails(
      actor.agencyId,
      storyId,
      { photoFile: null },
      this.event(actor, correlationId),
    );
    if (!result) throw new AppError(404, 'STORY_NOT_FOUND');
    if (result.previous)
      await this.storage
        .delete(this.storyKey(actor.agencyId, result.previous))
        .catch(() => undefined);
  }

  /** The wedding date shown on a story (or none, to clear it). */
  async setStoryWeddingDate(
    actor: ProfileActor,
    storyId: string,
    weddingDate: string | null,
    correlationId: string,
  ) {
    this.adminOnly(actor);
    const result = await this.db.setStoryDetails(
      actor.agencyId,
      storyId,
      { weddingDate },
      this.event(actor, correlationId),
    );
    if (!result) throw new AppError(404, 'STORY_NOT_FOUND');
  }

  /** A story's photo for the admin who manages it, whatever the story's state. Null when it has none. */
  async storyPhotoForAdmin(actor: ProfileActor, storyId: string): Promise<Buffer | null> {
    this.adminOnly(actor);
    const file = await this.db.storyPhotoFile(actor.agencyId, storyId);
    return file ? this.storage.get(this.storyKey(actor.agencyId, file)) : null;
  }

  /** A story's photo for the public site, only while its story is published. Null otherwise. */
  async storyPhotoFile(agencyId: string, file: string): Promise<Buffer | null> {
    if (!STORY_PHOTO_FILE.test(file)) return null;
    if (!(await this.db.isPublishedPhoto(agencyId, file))) return null;
    return this.storage.get(this.storyKey(agencyId, file));
  }

  private storyKey(agencyId: string, file: string) {
    return `${agencyId}/stories/${file}`;
  }

  /** Stores an uploaded home-page picture and returns its address; the caller links it, or deletes it again. */
  private async storeSiteImage(agencyId: string, bytes: Buffer): Promise<string> {
    if (bytes.length === 0 || bytes.length > MAX_SITE_IMAGE_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE');
    const image = await processSiteImage(bytes);
    const file = `img-${this.newId()}.webp`;
    await this.storage.put(this.key(agencyId, file), image, 'image/webp');
    return `${LOGO_PATH}${file}`;
  }

  /** Sets the hero, about or call-to-action picture, and removes the one it replaces. */
  async setImage(
    actor: ProfileActor,
    slot: SiteImageSlot,
    bytes: Buffer,
    correlationId: string,
  ): Promise<string> {
    this.adminOnly(actor);
    const url = await this.storeSiteImage(actor.agencyId, bytes);
    let previous: string | undefined;
    try {
      await this.db.update(
        actor.agencyId,
        (current) => {
          const images = { ...asObject(current.images) };
          previous = typeof images[slot] === 'string' ? (images[slot] as string) : undefined;
          images[slot] = url;
          return { ...current, images };
        },
        this.event(actor, correlationId),
      );
    } catch (error) {
      await this.deleteStored(actor.agencyId, url);
      throw error;
    }
    await this.deleteStored(actor.agencyId, previous);
    return url;
  }

  async removeImage(actor: ProfileActor, slot: SiteImageSlot, correlationId: string) {
    this.adminOnly(actor);
    let previous: string | undefined;
    await this.db.update(
      actor.agencyId,
      (current) => {
        const images = { ...asObject(current.images) };
        previous = typeof images[slot] === 'string' ? (images[slot] as string) : undefined;
        delete images[slot];
        return withImages(current, images);
      },
      this.event(actor, correlationId),
    );
    await this.deleteStored(actor.agencyId, previous);
  }

  /** Adds a picture at the end of the gallery (up to 24). */
  async addGalleryImage(
    actor: ProfileActor,
    bytes: Buffer,
    correlationId: string,
  ): Promise<string> {
    this.adminOnly(actor);
    const url = await this.storeSiteImage(actor.agencyId, bytes);
    try {
      await this.db.update(
        actor.agencyId,
        (current) => {
          const images = { ...asObject(current.images) };
          const gallery = Array.isArray(images.gallery) ? [...(images.gallery as unknown[])] : [];
          if (gallery.length >= MAX_GALLERY_IMAGES) throw new AppError(409, 'GALLERY_FULL');
          gallery.push({ url });
          images.gallery = gallery;
          return { ...current, images };
        },
        this.event(actor, correlationId),
      );
    } catch (error) {
      await this.deleteStored(actor.agencyId, url);
      throw error;
    }
    return url;
  }

  /** Saves the gallery's order and captions. */
  async setGallery(
    actor: ProfileActor,
    items: NonNullable<SiteContentInput['gallery']>,
    correlationId: string,
  ) {
    this.adminOnly(actor);
    await this.db.update(
      actor.agencyId,
      (current) => withGallery(current, items),
      this.event(actor, correlationId),
    );
  }

  /** Takes a picture out of the gallery and deletes its file. */
  async removeGalleryImage(actor: ProfileActor, file: string, correlationId: string) {
    this.adminOnly(actor);
    if (!SITE_IMAGE_FILE.test(file)) throw new AppError(404, 'NOT_FOUND');
    const url = `${LOGO_PATH}${file}`;
    let found = false;
    await this.db.update(
      actor.agencyId,
      (current) => {
        const images = { ...asObject(current.images) };
        const gallery = Array.isArray(images.gallery) ? (images.gallery as unknown[]) : [];
        const kept = gallery.filter((item) => asObject(item).url !== url);
        found = kept.length !== gallery.length;
        if (kept.length > 0) images.gallery = kept;
        else delete images.gallery;
        return withImages(current, images);
      },
      this.event(actor, correlationId),
    );
    if (!found) throw new AppError(404, 'NOT_FOUND');
    await this.deleteStored(actor.agencyId, url);
  }

  private key(agencyId: string, file: string) {
    return `${agencyId}/branding/${file}`;
  }

  /** Removes the file a logo address points to, when it is one this service stored. Never fails the change. */
  private async deleteStored(agencyId: string, url: string | undefined) {
    const file = url?.startsWith(LOGO_PATH) ? url.slice(LOGO_PATH.length) : undefined;
    if (file && (LOGO_FILE.test(file) || SITE_IMAGE_FILE.test(file)))
      await this.storage.delete(this.key(agencyId, file)).catch(() => undefined);
  }

  private event(actor: ProfileActor, correlationId: string) {
    return {
      id: this.newId(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      subjectId: null,
      type: 'site.content_updated' as const,
      version: 1 as const,
      occurredAt: this.now().toISOString(),
      correlationId,
    };
  }

  private adminOnly(actor: ProfileActor) {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}

/**
 * The value without its empty parts: undefined fields, objects and lists with nothing left, or nothing at
 * all. A list keeps the place of every item that is left (a missing step stays a missing step) and drops
 * only the empty ones at its end. Booleans are kept, because "hidden" is an answer.
 */
function pruned(value: unknown): Record<string, unknown> | undefined {
  const result = compact(value);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => compact(item) ?? {});
    while (items.length > 0 && isEmptyObject(items.at(-1))) items.pop();
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).flatMap(([key, part]) => {
      const inner = compact(part);
      return inner === undefined ? [] : [[key, inner] as const];
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value === '' || value === null ? undefined : value;
}

const isEmptyObject = (value: unknown) =>
  Boolean(value) && typeof value === 'object' && Object.keys(value as object).length === 0;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The content parts of a draft or a save applied to the stored config; empty parts are removed. */
function mergeContent(
  current: Record<string, unknown>,
  input: SiteContentInput,
): Record<string, unknown> {
  const next = { ...current };
  const set = (key: string, value: unknown) => {
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  set('contact', pruned(input.contact));
  set('home', pruned(input.home));
  set('auth', pruned(input.auth));
  set('about', pruned(input.about));
  set('branches', input.branches?.map((branch) => pruned(branch)).filter(Boolean));
  return input.gallery ? withGallery(next, input.gallery) : next;
}

/**
 * The gallery's order and captions applied to the config. Only pictures already in the gallery can be kept, so
 * the order and captions cannot link a foreign file, and a picture left out of the list is not deleted here.
 */
function withGallery(
  config: Record<string, unknown>,
  items: NonNullable<SiteContentInput['gallery']>,
): Record<string, unknown> {
  const stored = new Set(galleryUrls(config));
  const images = { ...asObject(config.images) };
  const seen = new Set<string>();
  const gallery = items
    .filter((item) => stored.has(item.url) && !seen.has(item.url) && seen.add(item.url))
    .map((item) => pruned(item))
    .filter(Boolean);
  // Pictures the list forgot stay at the end, so a stale page cannot silently drop an upload.
  for (const url of stored) if (!seen.has(url)) gallery.push({ url });
  if (gallery.length > 0) images.gallery = gallery;
  else delete images.gallery;
  return withImages(config, images);
}

function galleryUrls(config: Record<string, unknown>): string[] {
  const gallery = asObject(config.images).gallery;
  return Array.isArray(gallery)
    ? gallery.flatMap((item) => {
        const url = asObject(item).url;
        return typeof url === 'string' ? [url] : [];
      })
    : [];
}

/** The config with its pictures replaced; an empty set of pictures is removed. */
function withImages(
  config: Record<string, unknown>,
  images: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...config };
  if (Object.keys(images).length > 0) next.images = images;
  else delete next.images;
  return next;
}

/** The name, colours and look of a draft or a save applied to the stored config. */
function mergeBranding(
  current: Record<string, unknown>,
  input: BrandingInput,
): Record<string, unknown> {
  const next = { ...current };
  const branding = { ...asObject(current.branding) };
  if (input.primaryColor) branding.primaryColor = input.primaryColor;
  else delete branding.primaryColor;
  if (input.accentColor) branding.accentColor = input.accentColor;
  else delete branding.accentColor;
  if (input.theme && input.theme !== 'classic') branding.theme = input.theme;
  else delete branding.theme;
  if (input.name) next.name = input.name;
  else delete next.name;
  if (Object.keys(branding).length > 0) next.branding = branding;
  else delete next.branding;
  return next;
}
