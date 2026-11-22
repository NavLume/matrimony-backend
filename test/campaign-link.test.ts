import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignLinkInputSchema,
  LINK_KINDS,
  LINK_TAGS,
  linkPath,
  slugify,
  type CampaignLink,
} from '../src/bo/campaign-link.js';
import { sourceOf } from '../src/bo/consultation.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { CampaignLinkUnit } from '../src/db/service/campaign-link-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { CampaignLinkService } from '../src/service/campaign-link-service.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const actor = (role: 'admin' | 'agent' | 'member', accountId: string) => ({
  agencyId: AGENCY,
  accountId,
  role,
});

void test('a campaign name is made from Latin letters and digits; a Bangla name gives none', () => {
  assert.equal(slugify('Wedding Fair, Dec 2026!'), 'wedding-fair-dec-2026');
  assert.equal(slugify('  Café   Gulshan  '), 'cafe-gulshan');
  assert.equal(slugify('বিয়ের মেলা'), '');
  assert.ok(slugify('x'.repeat(200)).length <= 54);
});

void test('every kind of link is read back as the right lead source', () => {
  const expected = {
    facebook_ad: 'facebook',
    facebook_post: 'facebook',
    whatsapp: 'whatsapp',
    old_site: 'old_site',
    event_qr: 'qr',
    office_qr: 'qr',
    other: 'other_site',
  } as const;
  for (const kind of LINK_KINDS) {
    const tags = LINK_TAGS[kind];
    assert.equal(
      sourceOf({ utmSource: tags.source, utmMedium: tags.medium }, null),
      expected[kind],
      kind,
    );
  }
});

void test('the link opens Talk to an adviser with its tags, and an office QR code chooses the office', () => {
  assert.equal(
    linkPath({ kind: 'event_qr', slug: 'wedding-fair', office: null, locale: 'bn' }),
    '/bn/talk-to-us?utm_source=qr&utm_medium=event&utm_campaign=wedding-fair',
  );
  assert.equal(
    linkPath({ kind: 'office_qr', slug: 'lalmatia', office: 0, locale: 'en' }),
    '/en/talk-to-us?utm_source=qr&utm_medium=office&utm_campaign=lalmatia&office=1',
  );
});

void test('an office QR code needs an office, and no other kind takes one', () => {
  assert.throws(() => campaignLinkInputSchema.parse({ kind: 'office_qr', name: 'Lalmatia' }));
  assert.throws(() =>
    campaignLinkInputSchema.parse({ kind: 'facebook_ad', name: 'Eid', office: 1 }),
  );
  assert.equal(
    campaignLinkInputSchema.parse({ kind: 'office_qr', name: 'Lalmatia', office: 0 }).locale,
    'bn',
  );
});

function setup() {
  const state = { links: [] as CampaignLink[], events: [] as WorkflowEvent[] };
  const unit = {
    list: async (_a: string, archived: boolean) =>
      state.links.filter((l) => (l.archivedAt !== null) === archived),
    one: async (_a: string, id: string) => state.links.find((l) => l.id === id) ?? null,
    insert: async (
      _a: string,
      link: { kind: CampaignLink['kind']; name: string; slug: string; createdBy: string },
    ) => {
      if (state.links.some((l) => l.slug === link.slug)) return null;
      const id = `link-${state.links.length + 1}`;
      state.links.push({
        id,
        kind: link.kind,
        name: link.name,
        slug: link.slug,
        office: null,
        locale: 'bn',
        path: '',
        createdBy: { id: link.createdBy, name: '' },
        createdAt: '2026-11-21T10:00:00.000Z',
        archivedAt: null,
        leads: 0,
        verified: 0,
      });
      return id;
    },
    setArchived: async (_a: string, id: string, archived: boolean) => {
      state.links.find((l) => l.id === id)!.archivedAt = archived ? '2026-11-21T11:00:00Z' : null;
    },
    appendEvent: async (event: WorkflowEvent) => void state.events.push(event),
  } as unknown as CampaignLinkUnit;
  const service = new CampaignLinkService(
    { inTransaction: async (_a, work) => work(unit) },
    () => new Date('2026-11-21T10:00:00Z'),
    () => '00000000-0000-4000-8000-000000000001',
    () => new Uint8Array([0, 1, 2, 3]),
  );
  return { state, service };
}

const input = (name: string, kind: CampaignLink['kind'] = 'event_qr') =>
  campaignLinkInputSchema.parse({ kind, name });

void test('agents and admins make links; a taken name gets a number; a Bangla name gets the kind', async () => {
  const { state, service } = setup();
  const first = await service.create(actor('agent', AGENT), input('Wedding Fair'), 'c');
  const second = await service.create(actor('admin', ADMIN), input('Wedding fair!'), 'c');
  const bangla = await service.create(actor('agent', AGENT), input('বিয়ের মেলা', 'whatsapp'), 'c');
  assert.equal(first.slug, 'wedding-fair');
  assert.equal(second.slug, 'wedding-fair-2');
  assert.match(bangla.slug, /^whatsapp-[a-z2-9]{4}$/);
  assert.equal(state.events.length, 3);
  assert.equal(state.events[0]!.type, 'campaign_link.created');
  await assert.rejects(
    service.create(actor('member', OTHER), input('Mine'), 'c'),
    (e: AppError) => e.status === 403,
  );
  await assert.rejects(
    service.list(actor('member', OTHER), false),
    (e: AppError) => e.status === 403,
  );
});

void test('only an admin or the maker puts a link away; it can be brought back', async () => {
  const { state, service } = setup();
  const link = await service.create(actor('agent', AGENT), input('Gulshan fair'), 'c');
  await assert.rejects(
    service.archive(actor('agent', OTHER), link.id, true, 'c'),
    (e: AppError) => e.status === 403,
  );
  await service.archive(actor('agent', AGENT), link.id, true, 'c');
  assert.equal((await service.list(actor('agent', OTHER), false)).length, 0);
  assert.equal((await service.list(actor('agent', OTHER), true)).length, 1);
  await service.archive(actor('admin', ADMIN), link.id, false, 'c');
  await service.archive(actor('admin', ADMIN), link.id, false, 'c');
  assert.deepEqual(
    state.events.map((e) => e.type),
    ['campaign_link.created', 'campaign_link.archived', 'campaign_link.restored'],
  );
  await assert.rejects(
    service.archive(actor('admin', ADMIN), 'missing', true, 'c'),
    (e: AppError) => e.status === 404,
  );
});
