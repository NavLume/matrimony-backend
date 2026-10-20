import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_GROUPS, DEFAULT_PREFIXES, activityQuerySchema } from '../src/bo/activity.js';
import { encodeCursor } from '../src/bo/review.js';
import type { ActivityRepository } from '../src/db/raw/repository/activity-repository.js';
import type { ReportRepository } from '../src/db/raw/repository/report-repository.js';
import { AppError } from '../src/exception/app-error.js';
import { ActivityService } from '../src/service/activity-service.js';
import { ReportService } from '../src/service/report-service.js';
import { agency, accountId } from './fixtures.js';

const actor = (role: 'admin' | 'agent' | 'member') => ({ agencyId: agency, accountId, role });
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;
const tx = {
  transaction: async <T>(_a: string, work: (t: never) => Promise<T>) => work({} as never),
};

const row = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  type: 'payment.recorded',
  at: '2026-10-20T10:00:00.000Z',
  actor: null,
  subject: null,
  profileId: null,
  position: `2026-10-20T10:00:0${n}.000000Z`,
});

await test('only an admin reads the activity log', async () => {
  const service = new ActivityService(tx, {} as ActivityRepository);
  for (const role of ['agent', 'member'] as const)
    await assert.rejects(
      () => service.list(actor(role), activityQuerySchema.parse({})),
      code(403, 'ROLE_FORBIDDEN'),
    );
});

await test('the log leaves sign-ins out by default, narrows to a group, and escapes the search text', async () => {
  const seen: Array<{ prefixes: readonly string[]; text: string | null }> = [];
  const repo = {
    list: async (
      _t: never,
      _a: string,
      filter: { prefixes: readonly string[]; text: string | null },
    ) => {
      seen.push(filter);
      return [];
    },
  } as unknown as ActivityRepository;
  const service = new ActivityService(tx, repo);
  await service.list(actor('admin'), activityQuerySchema.parse({}));
  await service.list(
    actor('admin'),
    activityQuerySchema.parse({ group: 'payments', q: '50%_off' }),
  );
  assert.ok(!seen[0]!.prefixes.includes('auth'));
  assert.deepEqual(seen[0]!.prefixes, DEFAULT_PREFIXES);
  assert.deepEqual(seen[1]!.prefixes, ACTIVITY_GROUPS.payments);
  assert.equal(seen[1]!.text, '50\\%\\_off');
  assert.ok(ACTIVITY_GROUPS.site.includes('legal'));
  assert.ok(ACTIVITY_GROUPS.site.includes('site'));
});

await test('the log pages with a cursor, hides the internal position, and refuses a bad cursor or day range', async () => {
  const repo = { list: async () => [row(3), row(2), row(1)] } as unknown as ActivityRepository;
  const service = new ActivityService(tx, repo);
  const page = await service.list(actor('admin'), activityQuerySchema.parse({ limit: 2 }));
  assert.equal(page.items.length, 2);
  assert.ok(!('position' in page.items[0]!));
  assert.equal(page.next, encodeCursor({ createdAt: row(2).position, id: row(2).id }));
  const last = await service.list(actor('admin'), activityQuerySchema.parse({ limit: 5 }));
  assert.equal(last.next, null);
  await assert.rejects(
    () => service.list(actor('admin'), activityQuerySchema.parse({ after: 'nonsense' })),
    code(400, 'INVALID_REQUEST'),
  );
  await assert.rejects(
    () =>
      service.list(
        actor('admin'),
        activityQuerySchema.parse({ from: '2026-10-20', to: '2026-10-01' }),
      ),
    code(400, 'INVALID_REQUEST'),
  );
  assert.equal(activityQuerySchema.safeParse({ group: 'secrets' }).success, false);
  assert.equal(activityQuerySchema.safeParse({ limit: 500 }).success, false);
});

await test('the money, cancelled-payment and successful-connection reports are for admins only', async () => {
  const service = new ReportService(tx, {} as ReportRepository);
  for (const role of ['agent', 'member'] as const) {
    await assert.rejects(() => service.clientMoney(actor(role), null), code(403, 'ROLE_FORBIDDEN'));
    await assert.rejects(
      () => service.cancelledPayments(actor(role), { limit: 10 }),
      code(403, 'ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      () => service.successful(actor(role), { limit: 10 }),
      code(403, 'ROLE_FORBIDDEN'),
    );
  }
});

await test('report searches escape their text, and the cancelled table carries its totals and pages', async () => {
  const seen: Array<string | null> = [];
  const repo = {
    clientMoney: async (_t: never, _a: string, text: string | null) => {
      seen.push(text);
      return [];
    },
    cancelled: async (_t: never, _a: string, filter: { text: string | null }) => {
      seen.push(filter.text);
      return [row(2), row(1)];
    },
    cancelledTotals: async () => ({ count: 2, amount: 3000 }),
    successful: async (
      _t: never,
      _a: string,
      filter: { text: string | null; matched: boolean | null },
    ) => {
      seen.push(`${filter.text}|${filter.matched}`);
      return [];
    },
    successfulTotals: async () => ({ total: 0 }),
  } as unknown as ReportRepository;
  const service = new ReportService(tx, repo);
  await service.clientMoney(actor('admin'), 'Rah_im');
  await service.clientMoney(actor('admin'), null);
  const page = await service.cancelledPayments(actor('admin'), { limit: 1, q: '100%' });
  await service.successful(actor('admin'), { limit: 10, q: 'a\\b', matched: 'true' });
  assert.deepEqual(seen, ['Rah\\_im', null, '100\\%', 'a\\\\b|true']);
  assert.equal(page.items.length, 1);
  assert.ok(page.next);
  assert.deepEqual(page.totals, { count: 2, amount: 3000 });
  await assert.rejects(
    () => service.cancelledPayments(actor('admin'), { limit: 5, after: 'bad' }),
    code(400, 'INVALID_REQUEST'),
  );
  await assert.rejects(
    () => service.successful(actor('admin'), { limit: 5, after: 'bad' }),
    code(400, 'INVALID_REQUEST'),
  );
});
