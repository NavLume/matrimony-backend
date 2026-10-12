import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { ProposalRow } from '../src/bo/candidate.js';
import { profileInputSchema } from '../src/bo/profile.js';
import type { ProfileRecord } from '../src/bo/profile-state.js';
import type { CandidateUnit } from '../src/db/service/candidate-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { CandidateService, startOfBangladeshDay } from '../src/service/candidate-service.js';
import { bangladeshHour, startNightlyRefresh } from '../src/scheduler/nightly-refresh-scheduler.js';
import type { ProfileActor } from '../src/service/profile-service.js';

const agencyId = '11111111-1111-4111-8111-111111111111';
const admin: ProfileActor = {
  agencyId,
  accountId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
};
const agent: ProfileActor = {
  agencyId,
  accountId: '33333333-3333-4333-8333-333333333333',
  role: 'agent',
};
const member: ProfileActor = {
  agencyId,
  accountId: '44444444-4444-4444-8444-444444444444',
  role: 'member',
};
const today = new Date(Date.UTC(2026, 9, 10));
const parse = profileInputSchema(today);

let counter = 0;
function record(
  profile: Record<string, unknown>,
  preferences: Record<string, unknown> = {},
  extra: Partial<ProfileRecord> = {},
): ProfileRecord {
  counter += 1;
  const data = parse.parse({ profile: { fullName: `P${counter}`, ...profile }, preferences });
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    memberCode: `M${counter}`,
    status: 'active',
    version: 1,
    serviceMode: 'assisted',
    ownerId: null,
    assignedAgentId: agent.accountId,
    currentDivisionCode: null,
    createdAt: new Date(Date.UTC(2026, 0, 1 + counter)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1 + counter)).toISOString(),
    data,
    ...extra,
  } as ProfileRecord;
}

/** An in-memory unit that remembers what was saved, so a test can see what a run decided. */
function fake(client: ProfileRecord | null, pool: ProfileRecord[]) {
  const saved: ProposalRow[][] = [];
  const asked: { gender: string; limit: number }[] = [];
  const job = { claimed: false };
  const unit: CandidateUnit = {
    lockClient: async () => client,
    readClient: async () => client,
    pool: async (_agency, _client, gender, limit) => {
      asked.push({ gender, limit });
      return pool;
    },
    saveProposals: async (_a, _c, rows) => {
      saved.push([...rows]);
    },
    list: async () => [],
    settings: async () => null,
    saveSettings: async () => {},
    activeClients: async () => (client ? [client.id] : []),
    claimJob: async () => (job.claimed ? false : (job.claimed = true)),
    releasedCount: async () => 0,
    releasable: async () => [],
    markReleased: async () => [],
    markRemoved: async () => [],
    appendEvent: async () => {},
  };
  const service = new CandidateService(
    { inTransaction: async (_agency, work) => work(unit) },
    pino({ level: 'silent' }),
    () => today,
  );
  return { service, saved, asked };
}

const doctorWoman = { gender: 'female', professionCode: 'doctor', dateOfBirth: '1998-01-01' };
const clientMan = { gender: 'male', dateOfBirth: '1992-01-01' };

await test('only staff generate a list, and an agent only for their own client', async () => {
  const client = record(clientMan);
  const { service } = fake(client, []);
  await assert.rejects(
    service.generate(member, client.id),
    (e) => e instanceof AppError && e.status === 403,
  );
  const stranger: ProfileActor = { ...agent, accountId: '55555555-5555-4555-8555-555555555555' };
  await assert.rejects(
    service.generate(stranger, client.id),
    (e) => e instanceof AppError && e.status === 404,
  );
  await service.generate(agent, client.id);
  await service.generate(admin, client.id);
});

await test('a missing client is not found; one not yet published or without a gender is refused', async () => {
  await assert.rejects(
    fake(null, []).service.generate(admin, 'x'),
    (e) => e instanceof AppError && e.status === 404,
  );
  const draft = record(clientMan, {}, { status: 'draft' });
  await assert.rejects(
    fake(draft, []).service.generate(admin, draft.id),
    (e) => e instanceof AppError && e.status === 409 && e.code === 'PROFILE_NOT_PUBLISHED',
  );
  const noGender = record({ dateOfBirth: '1992-01-01' });
  await assert.rejects(
    fake(noGender, []).service.generate(admin, noGender.id),
    (e) => e instanceof AppError && e.status === 422 && e.code === 'CLIENT_GENDER_REQUIRED',
  );
});

await test("the pool is asked for the other gender, and the client's gender never leaves the service", async () => {
  const client = record(clientMan);
  const { service, asked } = fake(client, []);
  await service.generate(admin, client.id);
  assert.equal(asked[0]?.gender, 'male');
});

await test('candidates are ranked on both sides and the best are saved, at most one hundred', async () => {
  const client = record(clientMan, { professionCodes: ['doctor'] });
  const good = record(doctorWoman, { ageMin: 30, ageMax: 40 }); // fits both ways
  const oneWay = record(doctorWoman, { ageMin: 18, ageMax: 25 }); // she would likely say no
  const wrong = record({ ...doctorWoman, professionCode: 'teacher' }, { ageMin: 30, ageMax: 40 });
  const { service, saved } = fake(client, [wrong, oneWay, good]);
  const result = await service.generate(admin, client.id);
  const order = saved[0]!.map((row) => row.candidateId);
  assert.deepEqual(
    order,
    [good.id, wrong.id, oneWay.id].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  );
  assert.equal(order[0], good.id);
  // A mismatch ranks lower but is not removed: staff decide.
  assert.equal(order.length, 3);
  assert.equal(result.considered, 3);
  assert.equal(result.proposed, 3);

  const many = Array.from({ length: 130 }, () => record(doctorWoman));
  const big = fake(client, many);
  const bigResult = await big.service.generate(admin, client.id);
  assert.equal(big.saved[0]!.length, 100);
  assert.equal(bigResult.considered, 130);
  assert.equal(bigResult.proposed, 100);
});

await test('complexion changes nothing about who is proposed or in what order', async () => {
  const picky = record(clientMan, { complexionCodes: ['very_fair'] });
  const fair = record({ ...doctorWoman, complexionCode: 'very_fair' });
  const dark = record({ ...doctorWoman, complexionCode: 'dark' });
  const { service, saved } = fake(picky, [dark, fair]);
  await service.generate(admin, picky.id);
  assert.equal(saved[0]!.length, 2);
  assert.ok(saved[0]!.every((row) => row.forward.length === 0 && row.reverse.length === 0));
});

await test('a refresh quietly does nothing for a profile that cannot have a list, and otherwise runs', async () => {
  const draft = record(clientMan, {}, { status: 'draft' });
  const first = fake(draft, [record(doctorWoman)]);
  assert.equal(await first.service.refresh(agencyId, draft.id), null);
  assert.equal(first.saved.length, 0);

  const live = record(clientMan);
  const second = fake(live, [record(doctorWoman)]);
  const result = await second.service.refresh(agencyId, live.id);
  assert.equal(result?.proposed, 1);
  assert.equal(second.saved.length, 1);

  assert.equal(await fake(null, []).service.refresh(agencyId, 'missing'), null);
});

await test('reading a list needs staff who may manage the client', async () => {
  const client = record(clientMan);
  const { service } = fake(client, []);
  await assert.rejects(
    service.list(member, client.id, { state: 'proposed', limit: 100 }),
    (e) => e instanceof AppError && e.status === 403,
  );
  const stranger: ProfileActor = { ...agent, accountId: '55555555-5555-4555-8555-555555555555' };
  await assert.rejects(
    service.list(stranger, client.id, { state: 'proposed', limit: 100 }),
    (e) => e instanceof AppError && e.status === 404,
  );
  assert.deepEqual(await service.list(agent, client.id, { state: 'proposed', limit: 100 }), {
    items: [],
  });
});

await test('the nightly refresh runs once a day, for every published client, and says when it already ran', async () => {
  const client = record(clientMan);
  const t = fake(client, [record(doctorWoman)]);
  assert.equal(await t.service.refreshNightly('agency'), 1);
  assert.equal(t.saved.length, 1);
  // The same day again: today’s run was claimed, so nothing is done.
  assert.equal(await t.service.refreshNightly('agency'), null);
  assert.equal(t.saved.length, 1);
});

await test('one client that fails does not stop the rest of the nightly refresh', async () => {
  const client = record(clientMan);
  const t = fake(client, []);
  // A client without a gender is quietly skipped: nothing to refresh, nothing failed.
  assert.equal(
    await fake(record({ dateOfBirth: '1992-01-01' }), []).service.refreshNightly('a'),
    0,
  );
  assert.equal(await t.service.refreshNightly('agency'), 1);
});

await test('a day is a Bangladesh day: it starts at 18:00 UTC the evening before', () => {
  assert.equal(
    startOfBangladeshDay(new Date('2026-10-12T20:00:00Z')).toISOString(),
    '2026-10-12T18:00:00.000Z',
  );
  assert.equal(
    startOfBangladeshDay(new Date('2026-10-12T17:59:00Z')).toISOString(),
    '2026-10-11T18:00:00.000Z',
  );
  assert.equal(bangladeshHour(new Date('2026-10-12T20:00:00Z')), 2);
  assert.equal(bangladeshHour(new Date('2026-10-12T17:00:00Z')), 23);
  assert.equal(bangladeshHour(new Date('2026-10-12T19:30:00Z')), 1);
});

await test('the scheduler does nothing before 2 am Bangladesh time and asks every agency after', async () => {
  const calls: string[] = [];
  const candidates = {
    refreshNightly: async (agency: string) => {
      calls.push(agency);
      return 3;
    },
  };
  const logger = pino({ level: 'silent' });
  // 19:00 UTC is 01:00 in Bangladesh: too early.
  let now = new Date('2026-10-12T19:00:00Z');
  const stop = startNightlyRefresh(candidates, ['a', 'b'], logger, 5, () => now);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, 0);
  // 20:00 UTC is 02:00 in Bangladesh.
  now = new Date('2026-10-12T20:00:00Z');
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.ok(new Set<string>(calls).has('a') && new Set<string>(calls).has('b'));
});
