import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings, settingsInputSchema } from '../src/bo/agency-settings.js';
import {
  cleanPath,
  consultationActionSchema,
  consultationCodeSchema,
  consultationInputSchema,
  normaliseHost,
  referenceFrom,
  referrerHost,
  sourceOf,
  unverifiedInputSchema,
} from '../src/bo/consultation.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { NewConsultation } from '../src/db/raw/repository/consultation-repository.js';
import type { ConsultationUnit } from '../src/db/service/consultation-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { ConsultationProcess } from '../src/process/consultation-process.js';
import { ConsultationService } from '../src/service/consultation-service.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const actor = (role: 'admin' | 'agent' | 'member', accountId: string) => ({
  agencyId: AGENCY,
  accountId,
  role,
});
const PHONE = '+8801712345678';

// ---- pure rules -----------------------------------------------------------------------------------

void test('the source is read from campaign tags first, then the referring site', () => {
  assert.equal(sourceOf({ utmSource: 'qr', utmCampaign: 'lalmatia' }, 'msbd.test'), 'qr');
  assert.equal(sourceOf({ utmMedium: 'QR-code' }, 'msbd.test'), 'qr');
  assert.equal(sourceOf({ utmSource: 'facebook', utmMedium: 'paid' }, null), 'facebook');
  assert.equal(sourceOf({ utmSource: 'fb' }, null), 'facebook');
  assert.equal(sourceOf({ utmSource: 'google', utmMedium: 'cpc' }, null), 'google');
  assert.equal(sourceOf({ referrer: 'https://www.google.com.bd/search?q=x' }, null), 'google');
  assert.equal(sourceOf({ referrer: 'https://m.facebook.com/' }, null), 'facebook');
  assert.equal(sourceOf({ referrer: 'https://l.messenger.com/' }, null), 'facebook');
  assert.equal(sourceOf({ referrer: 'https://news.example.org/a' }, null), 'other_site');
  // Moving between the agency's own pages is not a referral.
  assert.equal(sourceOf({ referrer: 'https://www.msbd.test/about' }, 'msbd.test'), 'direct');
  assert.equal(sourceOf(undefined, null), 'direct');
  assert.equal(sourceOf({ utmSource: 'newsletter' }, null), 'other_site');
});

void test('the old site, by its tag or its address, and ad click ids are recognised', () => {
  const old = ['marriagesolutionbd.com'];
  assert.equal(sourceOf({ utmSource: 'old_site' }, null), 'old_site');
  assert.equal(sourceOf({ utmSource: 'old-site', utmCampaign: 'header' }, null), 'old_site');
  assert.equal(
    sourceOf({ referrer: 'https://www.marriagesolutionbd.com/blog/x' }, null, old),
    'old_site',
  );
  assert.equal(
    sourceOf({ referrer: 'https://shop.marriagesolutionbd.com/' }, null, old),
    'old_site',
  );
  assert.equal(
    sourceOf({ referrer: 'https://notmarriagesolutionbd.com/' }, null, old),
    'other_site',
  );
  // A forgotten tag: the network's own click id still names it.
  assert.equal(sourceOf({ clickId: 'facebook' }, null), 'facebook');
  assert.equal(sourceOf({ clickId: 'google', referrer: 'https://example.org/' }, null), 'google');
  // A deliberate tag wins over the click id.
  assert.equal(sourceOf({ utmSource: 'qr', clickId: 'facebook' }, null), 'qr');
  assert.equal(
    normaliseHost(' https://WWW.MarriageSolutionBD.com/contact '),
    'marriagesolutionbd.com',
  );
  assert.equal(normaliseHost('localhost'), null);
  assert.equal(normaliseHost('not a domain'), null);
});

void test('the old site addresses are an optional admin setting, kept as bare hosts', () => {
  const base = {
    attention: { reviewDays: 2, unansweredDays: 5, noCandidatesDays: 3, noMeetingDays: 7 },
    messaging: { enabled: false, perMemberDaily: 3, dailyLimit: 100 },
    assignment: { mode: 'automatic' },
  };
  assert.equal(settingsInputSchema.parse(base).leads, undefined);
  assert.deepEqual(
    settingsInputSchema.parse({
      ...base,
      leads: { oldSiteHosts: ['https://www.msbd.com/', 'msbd.com', 'blog.msbd.com'] },
    }).leads,
    { oldSiteHosts: ['msbd.com', 'blog.msbd.com'] },
  );
  assert.throws(() => settingsInputSchema.parse({ ...base, leads: { oldSiteHosts: ['nope'] } }));
  assert.deepEqual(parseSettings({}).leads, { oldSiteHosts: [], followUpHours: 2 });
  assert.deepEqual(parseSettings({ leads: { oldSiteHosts: ['msbd.com', 7, 'x'] } }).leads, {
    oldSiteHosts: ['msbd.com'],
    followUpHours: 2,
  });
});

void test('only the referrer host and the path without its query are kept', () => {
  assert.equal(referrerHost('https://www.Google.com/search?q=name+phone'), 'google.com');
  assert.equal(referrerHost('javascript:alert(1)'), null);
  assert.equal(referrerHost('not a url'), null);
  assert.equal(cleanPath('/bn/talk-to-us?utm_source=qr&phone=017'), '/bn/talk-to-us');
  assert.equal(cleanPath('https://evil.test/'), null);
});

void test('a reference has no characters that are easy to mishear', () => {
  const reference = referenceFrom(new Uint8Array([0, 1, 2, 3, 30, 31, 200, 255]));
  assert.match(reference, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.doesNotMatch(reference, /[01IOL]/);
});

void test('a broken tracking value never stops the enquiry', () => {
  const parsed = consultationInputSchema.parse({
    name: 'Rahima',
    phone: '01712345678',
    code: '123456',
    origin: { utmSource: 'x'.repeat(500), firstSeenAt: 'yesterday', referrer: 42 },
  });
  assert.equal(parsed.phone, PHONE);
  assert.equal(parsed.origin?.utmSource, undefined);
  assert.equal(parsed.origin?.firstSeenAt, undefined);
  assert.throws(() => consultationInputSchema.parse({ name: 'R', phone: '017', code: '1' }));
});
// ---- the service, with an in-memory unit ----------------------------------------------------------

interface Row extends NewConsultation {
  id: string;
  visits: number;
  callback: boolean;
  verified: boolean;
  codeSent: number;
  called: boolean;
  visit: string | null;
  whatsapp: boolean;
  forWhom: string | null;
  status: string;
  client?: { profileId: string; method: 'auto' | 'staff' } | null;
  blocked?: boolean;
  createdAt: Date;
  contacted: boolean;
  reminded: boolean;
  escalated: boolean;
  callLog: string[];
}

interface Client {
  id: string;
  code: string;
  agentId: string | null;
  phones: string[];
}

function setup(opts: { mode?: 'automatic' | 'manual'; agents?: string[]; now?: () => Date } = {}) {
  const state = {
    rows: [] as Row[],
    notes: [] as { to: string; template: string; reference: string }[],
    events: [] as WorkflowEvent[],
    active: new Set(opts.agents ?? [AGENT]),
    clients: [] as Client[],
  };
  const row = (id: string) => state.rows.find((r) => r.id === id)!;
  const unit = {
    agency: async () => ({
      publicConfig: {
        contact: { phone: '+880 2 5555 5555' },
        branches: [
          { name: { en: 'Lalmatia', bn: 'লালমাটিয়া' }, address: { en: 'Road 1' } },
          { name: { en: 'Gulshan' }, phone: '+880 2 4444 4444' },
        ],
      },
      settings: {
        assignment: { mode: opts.mode ?? 'automatic' },
        leads: { oldSiteHosts: ['msbd-old.test'] },
      },
    }),
    profileOfRef: async () => null,
    openByPhone: async (_a: string, phone: string) => {
      const found = [...state.rows]
        .reverse()
        .find((r) => r.phone === phone && r.status !== 'closed');
      return found
        ? {
            id: found.id,
            reference: found.reference,
            agentId: found.agentId,
            callbackRequested: found.callback,
            visitRequested: found.visit !== null,
            verified: found.verified,
          }
        : null;
    },
    chooseAdviser: async () => [...state.active][0] ?? null,
    isActiveStaff: async (_a: string, id: string) => state.active.has(id),
    insert: async (_a: string, lead: NewConsultation) => {
      if (state.rows.some((r) => r.reference === lead.reference)) return null;
      const id = `lead-${state.rows.length + 1}`;
      state.rows.push({
        ...lead,
        id,
        // 11:00 in Bangladesh.
        createdAt: new Date('2026-11-21T05:00:00Z'),
        contacted: false,
        reminded: false,
        escalated: false,
        callLog: [],
        visits: 1,
        // As the INSERT does: a proved number is verified, a call request asks for a call, a code alone neither.
        callback: lead.mode === 'callback',
        verified: lead.mode === 'verified',
        codeSent: lead.mode === 'code' ? 1 : 0,
        called: false,
        visit: null,
        whatsapp: false,
        forWhom: null,
        status: 'new',
      });
      return id;
    },
    revisit: async (_a: string, id: string, ticketHash: string, agentId: string | null) => {
      if (row(id).verified) row(id).visits++;
      row(id).verified = true;
      row(id).ticketHash = ticketHash;
      if (agentId) row(id).agentId = agentId;
    },
    requestAgain: async (_a: string, id: string) => {
      if (row(id).verified || row(id).callback) row(id).visits++;
      row(id).callback = true;
    },
    markCodeSent: async (_a: string, id: string) => void row(id).codeSent++,
    addCall: async (_a: string, id: string, call: { outcome: string }) => {
      row(id).callLog.push(call.outcome);
      row(id).contacted = true;
      if (row(id).status === 'new' && call.outcome !== 'no_answer') row(id).status = 'contacted';
    },
    waitingForCall: async () =>
      state.rows
        .filter((r) => r.status === 'new' && !r.contacted && (!r.reminded || !r.escalated))
        .map((r) => ({
          id: r.id,
          reference: r.reference,
          agentId: r.agentId,
          createdAt: r.createdAt,
          reminded: r.reminded,
          escalated: r.escalated,
        })),
    markReminded: async (_a: string, id: string) => void (row(id).reminded = true),
    markEscalated: async (_a: string, id: string) => {
      row(id).reminded = true;
      row(id).escalated = true;
    },
    byTicket: async (_a: string, reference: string, ticketHash: string) => {
      const found = state.rows.find(
        (r) => r.reference === reference && r.ticketHash === ticketHash,
      );
      return found
        ? {
            id: found.id,
            agentId: found.agentId,
            callbackRequested: found.callback,
            called: found.called,
            visitRequested: found.visit !== null,
          }
        : null;
    },
    markCallback: async (_a: string, id: string) => void (row(id).callback = true),
    markCalled: async (_a: string, id: string) => void (row(id).called = true),
    markVisit: async (_a: string, id: string, time: string) => void (row(id).visit = time),
    markWhatsapp: async (_a: string, id: string) => void (row(id).whatsapp = true),
    setForWhom: async (_a: string, id: string, forWhom: string) => void (row(id).forWhom = forWhom),
    adminIds: async () => [ADMIN],
    notify: async (_a: string, to: string, template: string, reference: string) =>
      void state.notes.push({ to, template, reference }),
    one: async (_a: string, id: string) => {
      const found = state.rows.find((r) => r.id === id);
      return found
        ? ({
            id: found.id,
            reference: found.reference,
            adviser: found.agentId ? { id: found.agentId, name: '' } : null,
            client: found.client,
            status: found.status,
            createdAt: found.createdAt.toISOString(),
            firstContactAt: found.contacted ? '2026-11-21T06:00:00.000Z' : null,
          } as never)
        : null;
    },
    list: async (_a: string, filter: { agentId: string | null }) =>
      state.rows.filter((r) => !filter.agentId || r.agentId === filter.agentId) as never,
    setStatus: async (_a: string, id: string, change: { status: string }) =>
      void (row(id).status = change.status),
    assign: async (_a: string, id: string, agentId: string) => void (row(id).agentId = agentId),
    isActiveAgent: async (_a: string, id: string) => state.active.has(id),
    appendEvent: async (event: WorkflowEvent) => void state.events.push(event),
    // Clients and their numbers, for linking enquiries to the client they became.
    linkPending: async () => {
      const linked: { id: string; profileId: string }[] = [];
      for (const lead of state.rows) {
        if (lead.client || lead.blocked) continue;
        const owners = state.clients.filter((c) => c.phones.includes(lead.phone));
        if (owners.length !== 1) continue;
        lead.client = { profileId: owners[0]!.id, method: 'auto' };
        linked.push({ id: lead.id, profileId: owners[0]!.id });
      }
      return linked;
    },
    profileByCode: async (_a: string, code: string) => {
      const found = state.clients.find((c) => c.code === code);
      return found ? { id: found.id, agentId: found.agentId } : null;
    },
    clientAgent: async (_a: string, profileId: string) => {
      const found = state.clients.find((c) => c.id === profileId);
      return found ? { agentId: found.agentId } : null;
    },
    linkClient: async (_a: string, id: string, profileId: string) =>
      void (row(id).client = { profileId, method: 'staff' }),
    unlinkClient: async (_a: string, id: string) => {
      row(id).client = null;
      row(id).blocked = true;
    },
    ofClient: async (_a: string, profileId: string) =>
      state.rows.filter((r) => r.client?.profileId === profileId) as never,
  } as unknown as ConsultationUnit;
  let n = 0;
  const service = new ConsultationService(
    { inTransaction: async (_a, work) => work(unit) },
    opts.now ?? (() => new Date('2026-11-21T10:00:00Z')),
    () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    (size) => new Uint8Array(size).map((_, i) => (i * 7 + n++) % 256),
  );
  return { state, service };
}

const input = {
  name: 'Rahima',
  phone: PHONE,
  intent: 'call' as const,
  origin: { utmSource: 'qr', utmCampaign: 'lalmatia' },
};

void test('a new enquiry is saved with its origin before the branch number is shown, and its agent is told', async () => {
  const { state, service } = setup();
  const result = await service.start(AGENCY, { ...input, office: 1 }, 'msbd.test');
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.source, 'qr');
  assert.equal(state.rows[0]!.utmCampaign, 'lalmatia');
  assert.equal(state.rows[0]!.office, 'Gulshan');
  assert.equal(state.rows[0]!.intent, 'call');
  assert.equal(state.rows[0]!.agentId, AGENT);
  assert.notEqual(state.rows[0]!.ticketHash, result.ticket, 'only a hash of the ticket is stored');
  assert.equal(
    result.officePhone,
    '+880 2 4444 4444',
    'the chosen branch number, else the agency number',
  );
  assert.equal('adviser' in result, false, 'no staff member is named to the visitor');
  assert.equal(result.returning, false);
  assert.deepEqual(state.notes, [{ to: AGENT, template: 'lead.new', reference: result.reference }]);
  assert.equal(state.events[0]!.type, 'lead.created');
});

void test('without a branch the agency number is given', async () => {
  const { service } = setup();
  assert.equal((await service.start(AGENCY, input, null)).officePhone, '+880 2 5555 5555');
});

void test('the same number again continues the same enquiry and keeps where it first came from', async () => {
  const { state, service } = setup();
  const first = await service.start(AGENCY, input, null);
  const again = await service.start(
    AGENCY,
    { ...input, intent: 'whatsapp', origin: { utmSource: 'facebook' } },
    null,
  );
  assert.equal(state.rows.length, 1);
  assert.equal(again.reference, first.reference);
  assert.equal(again.returning, true);
  assert.equal(state.rows[0]!.source, 'qr');
  assert.equal(state.rows[0]!.intent, 'call');
  assert.equal(state.rows[0]!.visits, 2);
  assert.notEqual(again.ticket, first.ticket);
  assert.equal(state.notes.length, 1, 'a returning visitor does not tell the agent again');
});

void test('a returning enquiry whose agent left gets a new one', async () => {
  const { state, service } = setup({ agents: [AGENT, OTHER] });
  await service.start(AGENCY, input, null);
  state.active.delete(AGENT);
  await service.start(AGENCY, input, null);
  assert.equal(state.rows[0]!.agentId, OTHER);
});

void test('a manual agency gives no agent and tells the admins', async () => {
  const { state, service } = setup({ mode: 'manual' });
  await service.start(AGENCY, input, null);
  assert.equal(state.rows[0]!.agentId, null);
  assert.deepEqual(
    state.notes.map((x) => x.to),
    [ADMIN],
  );
});

void test('when the code never arrives the request is kept unverified, as a call request, with no ticket', async () => {
  const { state, service } = setup();
  await service.requestUnverified(AGENCY, { ...input, office: 0 }, null);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.ticketHash, null);
  assert.equal(state.rows[0]!.callback, true);
  assert.equal(state.rows[0]!.source, 'qr');
  assert.equal(state.notes[0]!.template, 'lead.callback');
  // The same number asking again only adds a visit; proving it later continues the same enquiry.
  await service.requestUnverified(AGENCY, input, null);
  assert.equal(state.rows.length, 1);
  assert.equal(state.notes.length, 1);
  const proved = await service.start(AGENCY, input, null);
  assert.equal(proved.reference, state.rows[0]!.reference);
  assert.equal(proved.callbackRequested, true);
});

void test('asking for a code saves the lead at once; typing it later proves the same enquiry', async () => {
  const { state, service } = setup();
  await service.codeAsked(
    AGENCY,
    { ...input, origin: { referrer: 'https://msbd-old.test/contact' } },
    null,
  );
  assert.equal(state.rows.length, 1);
  const lead = state.rows[0]!;
  assert.equal(lead.mode, 'code');
  assert.equal(lead.source, 'old_site', 'the old-site address from the settings is used');
  assert.equal(lead.verified, false);
  assert.equal(lead.callback, false);
  assert.equal(lead.agentId, AGENT, 'an agent is chosen so someone can call');
  assert.equal(state.notes.length, 0, 'nobody is told for a code alone');
  // Asking again (resend) marks the same enquiry.
  await service.codeAsked(AGENCY, input, null);
  assert.equal(state.rows.length, 1);
  assert.equal(lead.codeSent, 2);
  // Typing the code: the same reference, a first proof (not a return), and now the agent is told.
  const proved = await service.start(AGENCY, input, null);
  assert.equal(proved.reference, lead.reference);
  assert.equal(proved.returning, false);
  assert.equal(lead.verified, true);
  assert.equal(lead.visits, 1);
  assert.equal(lead.source, 'old_site', 'where it came from stays');
  assert.deepEqual(state.notes, [{ to: AGENT, template: 'lead.new', reference: lead.reference }]);
  assert.deepEqual(
    state.events.map((e) => e.type),
    ['lead.created', 'lead.verified'],
  );
});

void test('a code asked for, then the code never came: one call request, one visit, staff told once', async () => {
  const { state, service } = setup();
  await service.codeAsked(AGENCY, input, null);
  await service.requestUnverified(AGENCY, input, null);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.callback, true);
  assert.equal(state.rows[0]!.visits, 1);
  assert.deepEqual(
    state.notes.map((x) => x.template),
    ['lead.callback'],
  );
  // Proving it afterwards does not announce a new enquiry again.
  await service.start(AGENCY, input, null);
  assert.equal(state.notes.length, 1);
});

void test('the code request saves the lead only with a name, and before the text is sent', async () => {
  const calls: string[] = [];
  const process = new ConsultationProcess(
    {
      start: async () => ({}) as never,
      codeAsked: async (_a, details) => void calls.push(`save:${details.name}`),
    },
    {
      sendLeadCode: async () => {
        calls.push('send');
        throw new AppError(429, 'CODE_RATE_LIMITED');
      },
      checkLeadCode: async () => undefined as never,
    },
  );
  const context = { agencyId: AGENCY, agencyName: 'MSBD' };
  await assert.rejects(
    process.sendCode(context, consultationCodeSchema.parse({ ...input, locale: 'bn' }), null),
    (e: AppError) => e.code === 'CODE_RATE_LIMITED',
  );
  assert.deepEqual(
    calls,
    ['save:Rahima', 'send'],
    'the lead is kept even when the text is refused',
  );
  calls.length = 0;
  await assert.rejects(
    process.sendCode(
      context,
      consultationCodeSchema.parse({ phone: '01712345678', locale: 'en' }),
      null,
    ),
  );
  assert.deepEqual(calls, ['send'], 'no name (an older page): only the code');
});

void test('next steps need the ticket: call me and visit tell the agent once, who-for is saved', async () => {
  const { state, service } = setup();
  const result = await service.start(AGENCY, input, null);
  const act = (action: 'callback' | 'call' | 'visit' | 'whatsapp', extra = {}) =>
    service.act(AGENCY, result.reference, { ticket: result.ticket, action, ...extra });
  await assert.rejects(
    service.act(AGENCY, result.reference, { ticket: 'x'.repeat(43), action: 'callback' }),
    (e: AppError) => e.status === 404,
  );
  await act('callback', { forWhom: 'child' });
  await act('callback');
  await act('visit', { visitTime: 'morning' });
  await act('visit', { visitTime: 'afternoon' });
  await act('whatsapp');
  await act('call');
  const lead = state.rows[0]!;
  assert.deepEqual(
    [lead.callback, lead.visit, lead.whatsapp, lead.called, lead.forWhom],
    [true, 'afternoon', true, true, 'child'],
  );
  assert.equal(state.notes.filter((x) => x.template === 'lead.callback').length, 2);
  assert.deepEqual(
    state.events.map((e) => e.type),
    ['lead.created', 'lead.callback_requested', 'lead.visit_requested'],
  );
});

void test('an old ticket stops working once the same number proves it again', async () => {
  const { service } = setup();
  const first = await service.start(AGENCY, input, null);
  await service.start(AGENCY, input, null);
  await assert.rejects(
    service.act(AGENCY, first.reference, { ticket: first.ticket, action: 'callback' }),
    (e: AppError) => e.status === 404,
  );
});

void test('agents read and work only their own enquiries; members none; admins all and can reassign', async () => {
  const { state, service } = setup({ agents: [AGENT, OTHER] });
  await service.start(AGENCY, input, null);
  const id = state.rows[0]!.id;
  assert.equal((await service.list(actor('agent', AGENT), {})).length, 1);
  assert.equal((await service.list(actor('agent', OTHER), {})).length, 0);
  assert.equal((await service.list(actor('admin', ADMIN), {})).length, 1);
  await assert.rejects(service.list(actor('member', ADMIN), {}), (e: AppError) => e.status === 403);
  await assert.rejects(
    service.update(actor('agent', OTHER), id, { status: 'contacted' }, 'c'),
    (e: AppError) => e.status === 404,
  );
  await service.update(actor('agent', AGENT), id, { status: 'contacted' }, 'c');
  assert.equal(state.rows[0]!.status, 'contacted');
  await assert.rejects(
    service.assign(actor('agent', AGENT), id, OTHER, 'c'),
    (e: AppError) => e.status === 403,
  );
  await service.assign(actor('admin', ADMIN), id, OTHER, 'c');
  assert.equal(state.rows[0]!.agentId, OTHER);
  assert.equal(state.notes.at(-1)!.to, OTHER);
  await assert.rejects(
    service.assign(actor('admin', ADMIN), id, '99999999-9999-4999-8999-999999999999', 'c'),
    (e: AppError) => e.status === 404,
  );
});

void test('an enquiry joins the one client with its number when staff read the list', async () => {
  const { state, service } = setup();
  await service.start(AGENCY, input, null);
  await service.start(AGENCY, { ...input, phone: '+8801811111111' }, null);
  state.clients.push(
    { id: 'p-1', code: 'M1000001', agentId: AGENT, phones: [PHONE] },
    // A parent's number on two children's profiles: never linked automatically.
    { id: 'p-2', code: 'M1000002', agentId: AGENT, phones: ['+8801811111111'] },
    { id: 'p-3', code: 'M1000003', agentId: AGENT, phones: ['+8801811111111'] },
  );
  await service.list(actor('admin', ADMIN), {});
  assert.deepEqual(state.rows[0]!.client, { profileId: 'p-1', method: 'auto' });
  assert.equal(state.rows[1]!.client, undefined);
  assert.equal(state.events.filter((e) => e.type === 'lead.linked').length, 1);
  // Reading again links nothing new.
  await service.list(actor('admin', ADMIN), {});
  assert.equal(state.events.filter((e) => e.type === 'lead.linked').length, 1);
});

void test('staff link by member code; only an admin undoes a link, and it is not redone automatically', async () => {
  const { state, service } = setup({ agents: [AGENT, OTHER] });
  await service.start(AGENCY, input, null);
  const id = state.rows[0]!.id;
  state.clients.push({ id: 'p-1', code: 'M1000001', agentId: AGENT, phones: [PHONE] });
  state.clients.push({ id: 'p-9', code: 'M1000009', agentId: OTHER, phones: [] });
  await assert.rejects(
    service.linkClient(actor('agent', OTHER), id, 'M1000009', 'c'),
    (e: AppError) => e.status === 404,
    'an agent links only an enquiry given to them',
  );
  await assert.rejects(
    service.linkClient(actor('agent', AGENT), id, 'M7777777', 'c'),
    (e: AppError) => e.code === 'PROFILE_NOT_FOUND',
  );
  await service.linkClient(actor('agent', AGENT), id, 'M1000009', 'c');
  assert.deepEqual(state.rows[0]!.client, { profileId: 'p-9', method: 'staff' });
  await assert.rejects(
    service.unlinkClient(actor('agent', AGENT), id, 'c'),
    (e: AppError) => e.status === 403,
  );
  await service.unlinkClient(actor('admin', ADMIN), id, 'c');
  await service.list(actor('admin', ADMIN), {});
  assert.equal(state.rows[0]!.client, null, 'an undone link is not made again by the number');
  assert.deepEqual(
    state.events.map((e) => e.type).filter((t) => t.startsWith('lead.') && t.includes('link')),
    ['lead.linked', 'lead.unlinked'],
  );
});

void test("a client's enquiries: the admin or the client's own agent", async () => {
  const { state, service } = setup({ agents: [AGENT, OTHER] });
  await service.start(AGENCY, input, null);
  state.clients.push({ id: 'p-1', code: 'M1000001', agentId: AGENT, phones: [PHONE] });
  assert.equal((await service.ofClient(actor('agent', AGENT), 'p-1')).length, 1);
  assert.equal((await service.ofClient(actor('admin', ADMIN), 'p-1')).length, 1);
  await assert.rejects(
    service.ofClient(actor('agent', OTHER), 'p-1'),
    (e: AppError) => e.code === 'PROFILE_NOT_FOUND',
  );
  await assert.rejects(
    service.ofClient(actor('admin', ADMIN), 'missing'),
    (e: AppError) => e.status === 404,
  );
});

void test('a call written down stops the follow-up; reaching the person moves the enquiry on', async () => {
  const { state, service } = setup({ agents: [AGENT, OTHER] });
  await service.start(AGENCY, input, null);
  const id = state.rows[0]!.id;
  await assert.rejects(
    service.addCall(actor('agent', OTHER), id, { outcome: 'no_answer' }, 'c'),
    (e: AppError) => e.status === 404,
  );
  let lead = await service.addCall(actor('agent', AGENT), id, { outcome: 'no_answer' }, 'c');
  assert.equal(state.rows[0]!.status, 'new', 'no answer: still new, but tried');
  assert.equal(lead.followUp.state, 'contacted');
  lead = await service.addCall(actor('agent', AGENT), id, { outcome: 'interested' }, 'c');
  assert.equal(state.rows[0]!.status, 'contacted');
  assert.deepEqual(state.rows[0]!.callLog, ['no_answer', 'interested']);
  await assert.rejects(
    service.addCall(
      actor('agent', AGENT),
      id,
      { outcome: 'call_later', callAgainAt: '2026-11-20T10:00:00.000Z' },
      'c',
    ),
    (e: AppError) => e.status === 400,
    'a time to call again must be ahead',
  );
});

void test('nobody called in time: the agent is reminded once, then the admins are told once', async () => {
  let now = new Date('2026-11-21T07:30:00Z'); // 13:30 in Bangladesh: 30 minutes past the 2-hour limit
  const { state, service } = setup({ now: () => now });
  await service.start(AGENCY, input, null);
  state.notes.length = 0;
  assert.equal(await service.remindOverdue(AGENCY, 'c'), 1);
  assert.deepEqual(state.notes, [
    { to: AGENT, template: 'lead.overdue', reference: state.rows[0]!.reference },
  ]);
  assert.equal(await service.remindOverdue(AGENCY, 'c'), 0, 'reminded once');
  now = new Date('2026-11-21T09:30:00Z'); // 15:30: past the second limit
  assert.equal(await service.remindOverdue(AGENCY, 'c'), 1);
  assert.deepEqual(
    state.notes.map((n) => n.to),
    [AGENT, ADMIN],
  );
  assert.equal(await service.remindOverdue(AGENCY, 'c'), 0, 'escalated once');
  assert.deepEqual(
    state.events.map((e) => e.type).filter((t) => t.startsWith('lead.follow_up')),
    ['lead.follow_up_reminded', 'lead.follow_up_escalated'],
  );
});

void test('an enquiry someone called is never reminded about', async () => {
  const { state, service } = setup({ now: () => new Date('2026-11-21T12:00:00Z') });
  await service.start(AGENCY, input, null);
  await service.addCall(actor('agent', AGENT), state.rows[0]!.id, { outcome: 'no_answer' }, 'c');
  state.notes.length = 0;
  assert.equal(await service.remindOverdue(AGENCY, 'c'), 0);
  assert.equal(state.notes.length, 0);
});

void test('where the visitor says they heard of us is kept beside the origin, never in its place', async () => {
  const { state, service } = setup();
  await service.codeAsked(AGENCY, { ...input, heardFrom: 'friend' }, null);
  assert.equal(state.rows[0]!.heardFrom, 'friend');
  assert.equal(state.rows[0]!.source, 'qr');
  assert.throws(() =>
    unverifiedInputSchema.parse({ name: 'Rahima', phone: '01712345678', heardFrom: 'tv' }),
  );
});

void test('the code is checked before anything is saved', async () => {
  const calls: string[] = [];
  const process = new ConsultationProcess(
    { start: async () => (calls.push('start'), {}) as never, codeAsked: async () => undefined },
    {
      sendLeadCode: async () => ({}) as never,
      checkLeadCode: async () => {
        calls.push('check');
        throw new AppError(400, 'CODE_INVALID');
      },
    },
  );
  await assert.rejects(
    process.submit(AGENCY, { ...input, code: '000000' } as never, null),
    (e: AppError) => e.code === 'CODE_INVALID',
  );
  assert.deepEqual(calls, ['check']);
});

void test('a next step and an unverified request read their input strictly', () => {
  assert.throws(() =>
    consultationActionSchema.parse({ ticket: 'a'.repeat(43), action: 'visit', visitTime: 'night' }),
  );
  assert.equal(
    consultationActionSchema.parse({ ticket: 'a'.repeat(43), action: 'whatsapp' }).action,
    'whatsapp',
  );
  assert.equal(
    unverifiedInputSchema.parse({ name: 'Rahima', phone: '01712345678' }).intent,
    'call',
  );
  assert.throws(() =>
    unverifiedInputSchema.parse({ name: 'Rahima', phone: '01712345678', code: '123456' }),
  );
});
