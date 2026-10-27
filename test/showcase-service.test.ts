import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageBand, parseShowcaseSettings } from '../src/bo/showcase.js';
import type { ShowcaseUnit } from '../src/db/service/showcase-db-service.js';
import { ShowcaseService } from '../src/service/showcase-service.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import { AppError } from '../src/exception/app-error.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT = '44444444-4444-4444-8444-444444444444';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const P1 = '66666666-6666-4666-8666-666666666661';
const actor = (role: 'admin' | 'agent' | 'member', accountId: string) => ({
  agencyId: AGENCY,
  accountId,
  role,
});

function setup(config: Record<string, unknown> = {}) {
  const state = {
    config,
    entries: new Set<string>(),
    events: [] as WorkflowEvent[],
    hidden: false,
    profile: { status: 'active', hidden: false, hasPhoto: true },
    leads: [] as { name: string; phone: string; profileId: string | null }[],
    cardRows: [] as Record<string, unknown>[],
  };
  const unit = {
    publicConfig: async () => state.config,
    config: async () => state.config,
    saveConfig: async (_a: string, next: Record<string, unknown>) => void (state.config = next),
    appendEvent: async (event: WorkflowEvent) => void state.events.push(event),
    cards: async () => state.cardRows,
    photoKey: async () => 'key',
    profileOfRef: async (_a: string, ref: string) => (ref === 'known' ? P1 : null),
    insertLead: async (
      _a: string,
      lead: { name: string; phone: string; profileId: string | null },
    ) => void state.leads.push(lead),
    entries: async () => [],
    eligible: async () => [],
    newLeadCount: async () => 0,
    profileForShowcase: async (_a: string, id: string) => (id === P1 ? state.profile : null),
    add: async (_a: string, id: string) => state.entries.add(id).size > 0,
    remove: async (_a: string, id: string) => state.entries.delete(id),
    switchTarget: async () => ({ id: P1, assignedAgentId: AGENT, hidden: state.hidden }),
    setHidden: async (_a: string, _id: string, hidden: boolean) => void (state.hidden = hidden),
  };
  const db = {
    inTransaction: async <T>(_agency: string, work: (u: ShowcaseUnit) => Promise<T>) =>
      work(unit as unknown as ShowcaseUnit),
  };
  return {
    state,
    service: new ShowcaseService(db, () => new Date('2026-10-27T10:00:00Z')),
  };
}

await test('settings: off and 12 cards unless the admin said otherwise, bad values fall back', () => {
  assert.deepEqual(parseShowcaseSettings({}), { enabled: false, limit: 12 });
  assert.deepEqual(parseShowcaseSettings({ showcase: { enabled: true, limit: 8 } }), {
    enabled: true,
    limit: 8,
  });
  assert.deepEqual(parseShowcaseSettings({ showcase: { enabled: 'yes', limit: 99 } }), {
    enabled: false,
    limit: 12,
  });
  assert.deepEqual(parseShowcaseSettings(null), { enabled: false, limit: 12 });
});

await test('the age is shown as a band of five years, never exact, and nothing for a missing date', () => {
  const today = new Date('2026-10-27T00:00:00Z');
  assert.deepEqual(ageBand('1999-03-01', today), { min: 25, max: 29 });
  assert.deepEqual(ageBand('1999-12-01', today), { min: 25, max: 29 });
  assert.deepEqual(ageBand('1990-01-01', today), { min: 35, max: 39 });
  assert.equal(ageBand(null, today), null);
  assert.equal(ageBand('2015-01-01', today), null);
  assert.equal(ageBand('not a date', today), null);
});

await test('while the showcase is off the public sees no card, and no picture', async () => {
  const { service, state } = setup();
  state.cardRows = [{ ref: 'r', dob: '1999-03-01' }];
  assert.deepEqual(await service.publicCards(AGENCY), []);
  assert.equal(await service.photoKey(AGENCY, 'r'), null);
  assert.equal(await service.acceptsLeads(AGENCY), false);
});

await test('a card carries only generic facts: a band, profession, district and a few words, no name or id', async () => {
  const { service, state } = setup({ showcase: { enabled: true, limit: 5 } });
  state.cardRows = [
    {
      ref: 'r1',
      dob: '1999-03-01',
      profession_code: 'doctor',
      current_district_code: 'dhaka',
      age_min: 24,
      age_max: 30,
      education_min_code: 'bachelor',
      profession_codes: ['engineer', 'teacher', 'doctor'],
      district_codes: ['dhaka', 'sylhet'],
      religious_practice_codes: ['regular'],
    },
  ];
  const [card] = await service.publicCards(AGENCY);
  assert.deepEqual(Object.keys(card!).sort(), [
    'ageBand',
    'countryCode',
    'districtCode',
    'professionCode',
    'ref',
    'religionCode',
    'wants',
  ]);
  assert.deepEqual(card!.ageBand, { min: 25, max: 29 });
  assert.deepEqual(card!.wants.professionCodes, ['engineer', 'teacher']);
  assert.deepEqual(card!.wants.districtCodes, ['dhaka']);
});

await test('only an admin controls the showcase, and the settings are saved with an event', async () => {
  const { service, state } = setup();
  await assert.rejects(() => service.overview(actor('agent', AGENT)), { code: 'ROLE_FORBIDDEN' });
  await assert.rejects(
    () => service.setSettings(actor('member', MEMBER), { enabled: true, limit: 5 }, 'r'),
    { code: 'ROLE_FORBIDDEN' },
  );
  await service.setSettings(actor('admin', ADMIN), { enabled: true, limit: 6 }, 'r');
  assert.deepEqual(parseShowcaseSettings(state.config), { enabled: true, limit: 6 });
  assert.equal(state.events.length, 1);
});

await test('only a published profile with a photo that was not switched off can be added', async () => {
  const { service, state } = setup();
  const admin = actor('admin', ADMIN);
  await assert.rejects(() => service.addEntry(admin, 'unknown', 'r'), {
    code: 'PROFILE_NOT_FOUND',
  });
  state.profile = { status: 'draft', hidden: false, hasPhoto: true };
  await assert.rejects(() => service.addEntry(admin, P1, 'r'), { code: 'PROFILE_NOT_PUBLISHED' });
  state.profile = { status: 'active', hidden: true, hasPhoto: true };
  await assert.rejects(() => service.addEntry(admin, P1, 'r'), { code: 'WEBSITE_HIDDEN' });
  state.profile = { status: 'active', hidden: false, hasPhoto: false };
  await assert.rejects(() => service.addEntry(admin, P1, 'r'), { code: 'PHOTO_REQUIRED' });
  state.profile = { status: 'active', hidden: false, hasPhoto: true };
  await service.addEntry(admin, P1, 'r');
  assert.ok(state.entries.has(P1));
  await service.removeEntry(admin, P1, 'r');
  assert.ok(!state.entries.has(P1));
  await assert.rejects(() => service.removeEntry(admin, P1, 'r'), { code: 'NOT_FOUND' });
});

await test('switching a profile off also takes it out of the showcase; an agent only for their own client', async () => {
  const { service, state } = setup();
  state.entries.add(P1);
  await service.setHidden(actor('member', MEMBER), true, { kind: 'own' }, 'r');
  assert.equal(state.hidden, true);
  assert.ok(!state.entries.has(P1));
  assert.equal(await service.hidden(actor('member', MEMBER), { kind: 'own' }), true);
  await service.setHidden(actor('agent', AGENT), false, { kind: 'client', profileId: P1 }, 'r');
  assert.equal(state.hidden, false);
  await assert.rejects(
    () =>
      service.setHidden(actor('agent', OTHER_AGENT), true, { kind: 'client', profileId: P1 }, 'r'),
    (error: unknown) => error instanceof AppError && error.code === 'PROFILE_NOT_FOUND',
  );
  // a member cannot use the staff route, and staff cannot use the member one
  await assert.rejects(
    () => service.setHidden(actor('member', MEMBER), true, { kind: 'client', profileId: P1 }, 'r'),
    { code: 'ROLE_FORBIDDEN' },
  );
  await assert.rejects(() => service.hidden(actor('agent', AGENT), { kind: 'own' }), {
    code: 'ROLE_FORBIDDEN',
  });
});

await test('a lead is stored with the card it was about when that card is still showable', async () => {
  const { service, state } = setup({ showcase: { enabled: true, limit: 5 } });
  await service.recordLead(AGENCY, { name: 'Karim', phone: '+8801712345678', ref: 'known' });
  await service.recordLead(AGENCY, { name: 'Salma', phone: '+8801812345678', ref: 'gone' });
  await service.recordLead(AGENCY, { name: 'Nasrin', phone: '+8801912345678' });
  assert.deepEqual(
    state.leads.map((l) => l.profileId),
    [P1, null, null],
  );
});

await test('a member asks their agent about a card: a reminder for the agent, once, and only for a member with an agent', async () => {
  const { service } = setup({ showcase: { enabled: true, limit: 5 } });
  const calls: string[] = [];
  const base = {
    switchTarget: async () => ({ id: P1, assignedAgentId: AGENT, hidden: false }),
    codeOfRef: async (_a: string, ref: string) => (ref === 'known' ? 'M1234567' : null),
    addIntroductionRequest: async (_a: string, r: { text: string; assignedTo: string }) => {
      calls.push(`${r.assignedTo}|${r.text}`);
      return calls.length === 1;
    },
  };
  const make = (extra: Record<string, unknown> = {}) =>
    new ShowcaseService(
      {
        inTransaction: async <T>(_a: string, work: (u: ShowcaseUnit) => Promise<T>) =>
          work({
            ...base,
            ...extra,
            appendEvent: async () => undefined,
          } as unknown as ShowcaseUnit),
      },
      () => new Date('2026-10-27T10:00:00Z'),
    );
  const member = actor('member', MEMBER);
  assert.deepEqual(await make().requestIntroduction(member, 'known', 'she is a doctor', 'r'), {
    created: true,
  });
  assert.equal(calls[0], `${AGENT}|Website: asked about M1234567: she is a doctor`);
  assert.deepEqual(await make().requestIntroduction(member, 'known', 'she is a doctor', 'r'), {
    created: false,
  });
  await assert.rejects(() => make().requestIntroduction(member, 'gone', undefined, 'r'), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(
    () =>
      make({
        switchTarget: async () => ({ id: P1, assignedAgentId: null, hidden: false }),
      }).requestIntroduction(member, 'known', undefined, 'r'),
    { code: 'NO_AGENT' },
  );
  await assert.rejects(
    () => service.requestIntroduction(actor('agent', AGENT), 'known', undefined, 'r'),
    {
      code: 'ROLE_FORBIDDEN',
    },
  );
});

await test('the browse filters accept codes and numbers, ignore empty values and refuse unknown codes', async () => {
  const { browseQuerySchema } = await import('../src/bo/showcase.js');
  const ok = browseQuerySchema.parse({
    district: '',
    religion: 'islam',
    ageMin: '25',
    ageMax: '',
    page: '2',
  });
  assert.equal(ok.district, undefined);
  assert.equal(ok.religion, 'islam');
  assert.equal(ok.ageMin, 25);
  assert.equal(ok.ageMax, undefined);
  assert.equal(ok.page, 2);
  assert.equal(browseQuerySchema.parse({}).page, 1);
  assert.equal(browseQuerySchema.safeParse({ country: 'atlantis' }).success, false);
  assert.equal(browseQuerySchema.safeParse({ ageMin: '5' }).success, false);
});
