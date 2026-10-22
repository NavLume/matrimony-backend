import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNALS, flagListQuerySchema, flagReviewSchema } from '../src/bo/flags.js';
import type { FlagRow } from '../src/bo/flags.js';
import type { FlagUnit } from '../src/db/service/flag-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { FlagService } from '../src/service/flag-service.js';

const agency = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222221';
const SALMA = '22222222-2222-4222-8222-222222222222';
const KAMAL = '22222222-2222-4222-8222-222222222223';
const MEMBER = '22222222-2222-4222-8222-222222222224';
const MINE = '33333333-3333-4333-8333-333333333331';
const THEIRS = '33333333-3333-4333-8333-333333333332';
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const flag = (
  profileId: string,
  signal: FlagRow['signal'],
  status: FlagRow['status'],
): FlagRow => ({
  profileId,
  memberCode: profileId === MINE ? 'M1' : 'M2',
  fullName: 'Someone',
  signal,
  others: [],
  count: 2,
  evidenceAt: '2026-10-22T00:00:00.000Z',
  status,
  reviewedBy: null,
  reviewedAt: null,
});

function fixture() {
  const stored: FlagRow[] = [
    flag(MINE, 'shared_phone', 'open'),
    flag(THEIRS, 'shared_photo', 'open'),
  ];
  const asked: { profileId: string | null; agentId: string | null }[] = [];
  const reviews: string[] = [];
  const events: string[] = [];
  const unit = {
    list: async (_a: string, scope: { profileId: string | null; agentId: string | null }) => {
      asked.push(scope);
      return stored.filter(
        (f) =>
          (scope.profileId === null || f.profileId === scope.profileId) &&
          (scope.agentId === null || (scope.agentId === SALMA && f.profileId === MINE)),
      );
    },
    profile: async (_a: string, id: string) =>
      id === MINE ? { assignedAgentId: SALMA } : id === THEIRS ? { assignedAgentId: KAMAL } : null,
    review: async (_a: string, profile: string, signal: string, outcome: string) => {
      reviews.push(`${profile}:${signal}:${outcome}`);
      const f = stored.find((x) => x.profileId === profile && x.signal === signal);
      if (f) f.status = outcome as FlagRow['status'];
    },
    appendEvent: async (event: { type: string }) => void events.push(event.type),
  } as unknown as FlagUnit;
  return {
    service: new FlagService(
      { inTransaction: async (_a, work) => work(unit) },
      () => new Date('2026-10-22T10:00:00.000Z'),
      () => '44444444-4444-4444-8444-444444444444',
    ),
    asked,
    reviews,
    events,
  };
}

const as = (accountId: string, role: 'admin' | 'agent' | 'member') => ({
  agencyId: agency,
  accountId,
  role,
});

await test('an admin sees every flag, an agent only those on their own clients, and a member none', async () => {
  const f = fixture();
  assert.equal((await f.service.list(as(ADMIN, 'admin'), 'open')).length, 2);
  const mine = await f.service.list(as(SALMA, 'agent'), 'open');
  assert.deepEqual(
    mine.map((x) => x.profileId),
    [MINE],
  );
  assert.deepEqual(f.asked.at(-1), { profileId: null, agentId: SALMA });
  await assert.rejects(f.service.list(as(MEMBER, 'member'), 'open'), code(403, 'ROLE_FORBIDDEN'));
  await assert.rejects(
    f.service.forClient(as(MEMBER, 'member'), MINE),
    code(403, 'ROLE_FORBIDDEN'),
  );
});

await test("a client's flags are for an admin or the client's own agent", async () => {
  const f = fixture();
  assert.equal((await f.service.forClient(as(SALMA, 'agent'), MINE)).length, 1);
  assert.equal((await f.service.forClient(as(ADMIN, 'admin'), THEIRS)).length, 1);
  await assert.rejects(
    f.service.forClient(as(SALMA, 'agent'), THEIRS),
    code(404, 'PROFILE_NOT_FOUND'),
  );
});

await test('deciding a flag records it and who decided; it needs a flag that applies now', async () => {
  const f = fixture();
  const after = await f.service.review(as(SALMA, 'agent'), MINE, 'shared_phone', 'fine', 'c');
  assert.deepEqual(f.reviews, [`${MINE}:shared_phone:fine`]);
  assert.deepEqual(f.events, ['flag.reviewed']);
  assert.equal(after[0]?.status, 'fine');
  // A flag that is not there cannot be decided, and another agent's client is not theirs to decide.
  await assert.rejects(
    f.service.review(as(SALMA, 'agent'), MINE, 'request_burst', 'fine', 'c'),
    code(404, 'FLAG_NOT_FOUND'),
  );
  await assert.rejects(
    f.service.review(as(SALMA, 'agent'), THEIRS, 'shared_photo', 'confirmed', 'c'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  assert.equal(f.reviews.length, 1);
});

await test('open and decided flags are listed apart, and a decision is fine or confirmed only', async () => {
  const f = fixture();
  await f.service.review(as(ADMIN, 'admin'), MINE, 'shared_phone', 'confirmed', 'c');
  assert.deepEqual(
    (await f.service.list(as(ADMIN, 'admin'), 'open')).map((x) => x.profileId),
    [THEIRS],
  );
  assert.deepEqual(
    (await f.service.list(as(ADMIN, 'admin'), 'reviewed')).map((x) => x.profileId),
    [MINE],
  );
  assert.equal(flagListQuerySchema.parse({}).state, 'open');
  assert.equal(flagReviewSchema.safeParse({ outcome: 'fine' }).success, true);
  assert.equal(flagReviewSchema.safeParse({ outcome: 'ban' }).success, false);
  assert.equal(SIGNALS.length, 6);
});
