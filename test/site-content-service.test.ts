import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicConfig } from '../src/bo/public-config.js';
import {
  brandingSchema,
  contrastOnDark,
  contrastOnWhite,
  siteContentSchema,
  weddingDateSchema,
} from '../src/bo/site-content.js';
import sharp from 'sharp';
import type { StoredPreview } from '../src/cache/repository/preview-repository.js';
import { SiteContentService } from '../src/service/site-content-service.js';
import type { WorkflowEvent } from '../src/bo/event.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const admin = {
  agencyId: AGENCY,
  accountId: '22222222-2222-4222-8222-222222222222',
  role: 'admin' as const,
};
const agent = { ...admin, role: 'agent' as const };

function setup(config: Record<string, unknown> = {}, published: unknown[] = []) {
  const state = { config, events: [] as WorkflowEvent[] };
  const files = new Map<string, Buffer>();
  const previews = new Map<string, StoredPreview>();
  const storage = {
    put: async (key: string, data: Buffer) => void files.set(key, data),
    get: async (key: string) => files.get(key) ?? null,
    delete: async (key: string) => void files.delete(key),
  };
  const stories = new Map<string, { photo: string | null; published: boolean; removed: boolean }>();
  const db = {
    setStoryDetails: async (_agency: string, id: string, change: { photoFile?: string | null }) => {
      const story = stories.get(id);
      if (!story || story.removed) return undefined;
      const previous = story.photo;
      if (change.photoFile !== undefined) story.photo = change.photoFile;
      return { previous };
    },
    isPublishedPhoto: async (_agency: string, file: string) =>
      [...stories.values()].some((s) => s.photo === file && s.published && !s.removed),
    storyPhotoFile: async (_agency: string, id: string) => stories.get(id)?.photo ?? null,
    readConfig: async () => ({
      config: state.config,
      published: published.length,
      agencyName: 'Agency',
    }),
    publishedStories: async () => published as never,
    update: async (
      _agency: string,
      change: (current: Record<string, unknown>) => Record<string, unknown>,
      event: WorkflowEvent,
    ) => {
      state.config = change(state.config);
      state.events.push(event);
      return state.config;
    },
  };
  let counter = 0;
  return {
    state,
    files,
    previews,
    stories,
    service: new SiteContentService(
      db,
      storage,
      () => new Date('2026-10-20T10:00:00Z'),
      () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
      {
        put: async (agency, id, preview) => void previews.set(`${agency}:${id}`, preview),
        get: async (agency, id) => previews.get(`${agency}:${id}`) ?? null,
      },
    ),
  };
}

await test('published stories come first, then the ones typed in by the operator', async () => {
  const { service } = setup({}, [
    { names: { en: 'Karim & Ayesha', bn: 'করিম ও আয়েশা' }, story: { en: 'Met here' }, year: 2026 },
  ]);
  const content = parsePublicConfig({ successStories: [{ names: { en: 'Sample couple' } }] });
  const merged = await service.withStories(AGENCY, content);
  assert.deepEqual(
    merged.successStories.map((s) => s.names.en),
    ['Karim & Ayesha', 'Sample couple'],
  );
  assert.equal(merged.successStories[0]?.year, 2026);
});

await test('with nothing published the content is served as it is', async () => {
  const { service } = setup();
  const content = parsePublicConfig({ successStories: [{ names: { en: 'Sample couple' } }] });
  assert.equal(await service.withStories(AGENCY, content), content);
});

await test('an admin saves the words, empty fields are removed and other settings stay', async () => {
  const { service, state } = setup({
    name: 'MSBD',
    branding: { primaryColor: '#8a1c3c' },
    contact: { phone: '123' },
    about: { en: 'Old' },
  });
  await service.update(
    admin,
    siteContentSchema.parse({
      contact: { phone: ' +880 1700-000000 ', email: '' },
      home: { title: { bn: '', en: 'Hello' }, subtitle: { bn: '', en: '' } },
      about: { bn: '', en: '' },
      branches: [{ name: { en: 'Dhaka' }, address: { en: '' }, phone: '', mapUrl: '' }],
    }),
    'req-1',
  );
  assert.deepEqual(state.config, {
    name: 'MSBD',
    branding: { primaryColor: '#8a1c3c' },
    contact: { phone: '+880 1700-000000' },
    home: { title: { en: 'Hello' } },
    branches: [{ name: { en: 'Dhaka' } }],
  });
  assert.equal(state.events[0]?.type, 'site.content_updated');
  assert.equal(state.events[0]?.actorId, admin.accountId);
});

await test('only an admin reads or changes the site content', async () => {
  const { service } = setup();
  await assert.rejects(() => service.get(agent), { code: 'ROLE_FORBIDDEN' });
  await assert.rejects(() => service.update(agent, siteContentSchema.parse({}), 'r'), {
    code: 'ROLE_FORBIDDEN',
  });
});

await test('a map link must be https, a branch needs a name, at most three branches', () => {
  const branch = (extra: object) => ({ branches: [{ name: { en: 'A' }, ...extra }] });
  assert.equal(
    siteContentSchema.safeParse(branch({ mapUrl: 'http://x.example/m' })).success,
    false,
  );
  assert.equal(
    siteContentSchema.safeParse(branch({ mapUrl: 'javascript:alert(1)' })).success,
    false,
  );
  assert.equal(
    siteContentSchema.safeParse(branch({ mapUrl: 'https://maps.example/m' })).success,
    true,
  );
  assert.equal(
    siteContentSchema.safeParse({ branches: [{ address: { en: 'x' } }] }).success,
    false,
  );
  assert.equal(
    siteContentSchema.safeParse({
      branches: Array.from({ length: 4 }, () => ({ name: { en: 'A' } })),
    }).success,
    false,
  );
  assert.equal(siteContentSchema.safeParse({ unknown: 1 }).success, false);
  assert.equal(siteContentSchema.safeParse({ contact: { email: 'not-an-email' } }).success, false);
});

const png = (size: number) =>
  sharp({ create: { width: size, height: size, channels: 4, background: '#8a1c3c' } })
    .png()
    .toBuffer();

await test('the name and colour are saved, and empty ones are removed', async () => {
  const { service, state } = setup({
    name: 'Old',
    branding: { logoUrl: '/x', primaryColor: '#000000' },
  });
  await service.setBranding(
    admin,
    brandingSchema.parse({ name: ' New name ', primaryColor: '#8a1c3c' }),
    'r',
  );
  assert.deepEqual(state.config, {
    name: 'New name',
    branding: { logoUrl: '/x', primaryColor: '#8a1c3c' },
  });
  await service.setBranding(admin, brandingSchema.parse({ name: '', primaryColor: '' }), 'r');
  assert.deepEqual(state.config, { branding: { logoUrl: '/x' } });
});

await test('a colour must be a hex colour that white can be read on', () => {
  assert.equal(brandingSchema.safeParse({ primaryColor: 'red' }).success, false);
  assert.equal(brandingSchema.safeParse({ primaryColor: '#ffee00' }).success, false);
  assert.equal(brandingSchema.safeParse({ primaryColor: '#8a1c3c' }).success, true);
  assert.ok(contrastOnWhite('#000000') > 20 && contrastOnWhite('#ffffff') < 1.1);
});

await test('a logo is stored as WebP, replaces the old one, and can be removed', async () => {
  const { service, state, files } = setup();
  const first = await service.setLogo(admin, await png(300), 'r');
  assert.match(first, /^\/api\/v1\/public\/branding\/logo-[0-9a-f-]{36}\.webp$/);
  assert.equal(files.size, 1);
  const file = first.split('/').pop()!;
  assert.ok(await service.logoFile(AGENCY, file));
  assert.equal(await service.logoFile('33333333-3333-4333-8333-333333333333', file), null);
  const second = await service.setLogo(admin, await png(300), 'r');
  assert.notEqual(second, first);
  assert.equal(files.size, 1);
  assert.deepEqual(state.config, { branding: { logoUrl: second } });
  await service.removeLogo(admin, 'r');
  assert.equal(files.size, 0);
  assert.deepEqual(state.config, {});
});

await test('a logo that is not a small enough real picture is refused, and only admins upload', async () => {
  const { service, files } = setup();
  const tiny = await png(8);
  const fine = await png(300);
  await assert.rejects(() => service.setLogo(admin, Buffer.from('<svg onload="x()"></svg>'), 'r'), {
    code: 'LOGO_INVALID',
  });
  await assert.rejects(() => service.setLogo(admin, tiny, 'r'), { code: 'LOGO_TOO_SMALL' });
  await assert.rejects(() => service.setLogo(admin, Buffer.alloc(3 * 1024 * 1024), 'r'), {
    code: 'PAYLOAD_TOO_LARGE',
  });
  await assert.rejects(() => service.setLogo(agent, fine, 'r'), {
    code: 'ROLE_FORBIDDEN',
  });
  assert.equal(files.size, 0);
  assert.equal(await service.logoFile(AGENCY, '../../etc/passwd'), null);
});

await test('home sections keep their order, hidden flag and words; empty parts are removed', async () => {
  const { service, state } = setup();
  await service.update(
    admin,
    siteContentSchema.parse({
      home: {
        sections: [
          {
            id: 'why',
            visible: true,
            title: { en: 'Why us' },
            items: [{ title: { en: 'A' } }, {}, { text: { en: 'C' } }, {}],
          },
          { id: 'village', visible: false },
          { id: 'how', title: { bn: '', en: '' } },
        ],
      },
      auth: { headline: { en: 'Welcome back' }, text: { en: '' }, scene: false },
    }),
    'r',
  );
  assert.deepEqual(state.config, {
    home: {
      sections: [
        {
          id: 'why',
          visible: true,
          title: { en: 'Why us' },
          items: [{ title: { en: 'A' } }, {}, { text: { en: 'C' } }],
        },
        { id: 'village', visible: false },
        { id: 'how' },
      ],
    },
    auth: { headline: { en: 'Welcome back' }, scene: false },
  });
  const read = await service.get(admin);
  assert.equal(read.home.sections?.length, 3);
  assert.equal(read.auth.scene, false);
});

await test('sections must be known, not repeated, and not too many', () => {
  const home = (sections: unknown[]) => siteContentSchema.safeParse({ home: { sections } }).success;
  assert.equal(home([{ id: 'village' }, { id: 'how' }]), true);
  assert.equal(home([{ id: 'village' }, { id: 'village' }]), false);
  assert.equal(home([{ id: 'hero' }]), false);
  assert.equal(home([{ id: 'village', surprise: 1 }]), false);
  assert.equal(
    home(
      ['village', 'how', 'why', 'trust', 'stories', 'agency', 'final', 'village'].map((id) => ({
        id,
      })),
    ),
    false,
  );
});

await test('the public config keeps valid sections and drops broken ones', () => {
  const config = parsePublicConfig({
    home: {
      sections: [
        { id: 'how', visible: false },
        { id: 'nope' },
        { id: 'why', items: [{ title: { en: 'x' } }] },
      ],
    },
    auth: { scene: false, headline: { bn: 'স্বাগতম' } },
  });
  assert.deepEqual(
    config.home?.sections?.map((s) => s.id),
    ['how', 'why'],
  );
  assert.equal(config.home?.sections?.[0]?.visible, false);
  assert.equal(config.auth?.scene, false);
});

await test('a theme and an accent colour are saved; the classic theme is the default and is not stored', async () => {
  const { service, state } = setup({ branding: { theme: 'warm', accentColor: '#d6a24a' } });
  await service.setBranding(
    admin,
    brandingSchema.parse({ theme: 'modern', accentColor: '#f59e0b', primaryColor: '#1f4fd8' }),
    'r',
  );
  assert.deepEqual(state.config, {
    branding: { theme: 'modern', accentColor: '#f59e0b', primaryColor: '#1f4fd8' },
  });
  await service.setBranding(
    admin,
    brandingSchema.parse({ theme: 'classic', accentColor: '' }),
    'r',
  );
  assert.deepEqual(state.config, {});
  const read = await service.get(admin);
  assert.equal(read.branding.theme, undefined);
});

await test('only known themes, and an accent that dark text can be read on', () => {
  assert.equal(brandingSchema.safeParse({ theme: 'neon' }).success, false);
  assert.equal(brandingSchema.safeParse({ accentColor: '#1a1a40' }).success, false);
  assert.equal(brandingSchema.safeParse({ accentColor: 'gold' }).success, false);
  assert.equal(brandingSchema.safeParse({ accentColor: '#d6a24a' }).success, true);
  assert.ok(contrastOnDark('#ffffff') > 15 && contrastOnDark('#000000') < 1);
});

await test('a preview applies the draft to a copy, never saves it, and can be read back by its link', async () => {
  const { service, state, previews } = setup({
    name: 'Saved name',
    branding: { primaryColor: '#8a1c3c' },
  });
  const before = JSON.stringify(state.config);
  const { id } = await service.preview(
    admin,
    { name: 'Agency', locale: 'en' },
    {
      branding: brandingSchema.parse({
        theme: 'royal',
        primaryColor: '#1e2a5a',
        name: 'Draft name',
      }),
      content: siteContentSchema.parse({ home: { title: { en: 'A new heading' } } }),
    },
  );
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(state.config), before);
  assert.equal(state.events.length, 0);
  assert.equal(previews.size, 1);
  const read = await service.readPreview(AGENCY, id);
  const content = read?.content as {
    branding?: { theme?: string; primaryColor?: string };
    home?: { title?: { en?: string } };
  };
  assert.equal(read?.name, 'Draft name');
  assert.equal(content.branding?.theme, 'royal');
  assert.equal(content.branding?.primaryColor, '#1e2a5a');
  assert.equal(content.home?.title?.en, 'A new heading');
});

await test('a preview link belongs to its agency, is a long random id, and only an admin makes one', async () => {
  const { service } = setup();
  const { id } = await service.preview(admin, { name: 'A', locale: 'bn' }, {});
  assert.equal(await service.readPreview('33333333-3333-4333-8333-333333333333', id), null);
  assert.equal(await service.readPreview(AGENCY, 'not-a-link'), null);
  assert.equal(await service.readPreview(AGENCY, '0'.repeat(32)), null);
  await assert.rejects(() => service.preview(agent, { name: 'A', locale: 'bn' }, {}), {
    code: 'ROLE_FORBIDDEN',
  });
  const other = await service.preview(admin, { name: 'A', locale: 'bn' }, {});
  assert.notEqual(other.id, id);
});

const png400 = await png(400);
const png50 = await png(50);
await test('home pictures are stored as WebP, replace the old one and can be removed', async () => {
  const { service, state, files } = setup();
  const hero = await service.setImage(admin, 'hero', await png(400), 'r');
  assert.match(hero, /^\/api\/v1\/public\/branding\/img-[0-9a-f-]{36}\.webp$/);
  assert.ok(await service.logoFile(AGENCY, hero.split('/').pop()!));
  const second = await service.setImage(admin, 'hero', await png(400), 'r');
  assert.equal(files.size, 1);
  assert.deepEqual(state.config, { images: { hero: second } });
  await service.removeImage(admin, 'hero', 'r');
  assert.equal(files.size, 0);
  assert.deepEqual(state.config, {});
  await assert.rejects(() => service.setImage(agent, 'hero', png400, 'r'), {
    code: 'ROLE_FORBIDDEN',
  });
  await assert.rejects(() => service.setImage(admin, 'hero', png50, 'r'), {
    code: 'IMAGE_TOO_SMALL',
  });
  await assert.rejects(() => service.setImage(admin, 'hero', Buffer.from('<svg/>'), 'r'), {
    code: 'IMAGE_INVALID',
  });
  assert.equal(files.size, 0);
});

await test('the gallery grows one picture at a time, keeps its order and captions, and cannot link foreign files', async () => {
  const { service, state, files } = setup();
  const a = await service.addGalleryImage(admin, await png(400), 'r');
  const b = await service.addGalleryImage(admin, await png(400), 'r');
  await service.update(
    admin,
    siteContentSchema.parse({
      gallery: [
        { url: b, caption: { en: 'Second first', bn: '' } },
        { url: a },
        { url: '/api/v1/public/branding/img-99999999-9999-4999-8999-999999999999.webp' },
      ],
    }),
    'r',
  );
  const gallery = (state.config.images as { gallery: { url: string }[] }).gallery;
  assert.deepEqual(gallery, [{ url: b, caption: { en: 'Second first' } }, { url: a }]);
  await service.removeGalleryImage(admin, a.split('/').pop()!, 'r');
  assert.equal(files.size, 1);
  assert.deepEqual((state.config.images as { gallery: unknown[] }).gallery.length, 1);
  await assert.rejects(() => service.removeGalleryImage(admin, a.split('/').pop()!, 'r'), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(() => service.removeGalleryImage(admin, '../x', 'r'), { code: 'NOT_FOUND' });
  assert.equal(
    siteContentSchema.safeParse({ gallery: [{ url: 'https://evil.example/x.webp' }] }).success,
    false,
  );
});

await test('a story photo is shown only while the story is published, and goes with it when removed', async () => {
  const { service, stories, files } = setup();
  const id = '44444444-4444-4444-8444-444444444444';
  stories.set(id, { photo: null, published: false, removed: false });
  await service.setStoryPhoto(admin, id, await png(400), 'r');
  const file = stories.get(id)!.photo!;
  assert.match(file, /^story-[0-9a-f-]{36}\.webp$/);
  assert.equal(await service.storyPhotoFile(AGENCY, file), null);
  assert.ok(await service.storyPhotoForAdmin(admin, id));
  stories.get(id)!.published = true;
  assert.ok(await service.storyPhotoFile(AGENCY, file));
  await service.setStoryPhoto(admin, id, await png(400), 'r');
  assert.equal(files.size, 1);
  await service.removeStoryPhoto(admin, id, 'r');
  assert.equal(files.size, 0);
  await assert.rejects(
    () => service.setStoryPhoto(admin, '55555555-5555-4555-8555-555555555555', png400, 'r'),
    { code: 'STORY_NOT_FOUND' },
  );
  stories.get(id)!.removed = true;
  await assert.rejects(() => service.setStoryPhoto(admin, id, png400, 'r'), {
    code: 'STORY_NOT_FOUND',
  });
  assert.equal(files.size, 0);
  await assert.rejects(() => service.setStoryPhoto(agent, id, png400, 'r'), {
    code: 'ROLE_FORBIDDEN',
  });
});

await test('a wedding date must be a real date', () => {
  assert.equal(weddingDateSchema.safeParse({ weddingDate: '2026-02-14' }).success, true);
  assert.equal(weddingDateSchema.safeParse({ weddingDate: null }).success, true);
  assert.equal(weddingDateSchema.safeParse({ weddingDate: '2026-02-30' }).success, false);
  assert.equal(weddingDateSchema.safeParse({ weddingDate: 'soon' }).success, false);
});

await test('the public config keeps only stored picture addresses', () => {
  const config = parsePublicConfig({
    images: {
      hero: 'https://evil.example/x.png',
      about: '/api/v1/public/branding/img-11111111-1111-4111-8111-111111111111.webp',
      gallery: [
        { url: '/etc/passwd' },
        { url: '/api/v1/public/branding/img-11111111-1111-4111-8111-111111111111.webp' },
      ],
    },
    successStories: [
      { names: { en: 'A' }, photoUrl: 'https://evil.example/x.png', weddingDate: '2026-02-14' },
    ],
  });
  assert.equal(config.images?.hero, undefined);
  assert.ok(config.images?.about);
  assert.equal(config.images?.gallery.length, 1);
  assert.equal(config.successStories[0]?.photoUrl, undefined);
  assert.equal(config.successStories[0]?.weddingDate, '2026-02-14');
});
