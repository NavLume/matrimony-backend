import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, funnelOf, funnelQuerySchema, type StageTimes } from '../src/bo/funnel.js';
import type { FunnelDbService } from '../src/db/service/funnel-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { FunnelService } from '../src/service/funnel-service.js';

const agency = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222221';
const SALMA = '22222222-2222-4222-8222-222222222222';
const KAMAL = '22222222-2222-4222-8222-222222222223';
const MEMBER = '22222222-2222-4222-8222-222222222224';
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const d = (day: number) => new Date(Date.UTC(2026, 9, day));
/** A person's times by stage: the days of the month they reached each one, null for none. */
const person = (...days: (number | null)[]): StageTimes =>
  Array.from({ length: STAGES.length }, (_, i) => (days[i] != null ? d(days[i]!) : null));

await test('a funnel never grows from one stage to the next, and counts people who reached a stage or any later one', () => {
  const funnel = funnelOf([
    person(1), // registered only
    person(1, 2), // submitted
    person(1, 2, 3, 4, 5, 6, 7, 8, 9), // all the way to a match
    // A match with no fee recorded: they still passed the fee stage.
    person(1, 2, 3, null, 5, 6, 7, 8, 9),
  ]);
  assert.equal(funnel.total, 4);
  assert.deepEqual(
    funnel.stages.map((s) => s.count),
    [4, 3, 2, 2, 2, 2, 2, 2, 2],
  );
  for (let i = 1; i < funnel.stages.length; i++)
    assert.ok(funnel.stages[i]!.count <= funnel.stages[i - 1]!.count);
});

await test('each stage shows its share of everyone and of the stage before, and the average days from it', () => {
  const funnel = funnelOf([person(1, 3), person(1, 5), person(1), person(1)]);
  const submitted = funnel.stages[1]!;
  assert.equal(submitted.count, 2);
  assert.equal(submitted.ofRegistered, 0.5);
  assert.equal(submitted.ofPrevious, 0.5);
  assert.equal(submitted.averageDaysFromPrevious, 3);
  assert.equal(funnel.stages[0]!.ofPrevious, null);
  assert.equal(funnel.stages[0]!.averageDaysFromPrevious, null);
  // Nobody reached the next stage: no average, and a share of zero.
  assert.equal(funnel.stages[2]!.averageDaysFromPrevious, null);
  assert.equal(funnel.stages[2]!.ofPrevious, 0);
});

await test('the average days uses only people with a record of both stages, and never goes below zero', () => {
  const funnel = funnelOf([person(1, 4), person(10, 9), person(1, null, 6)]);
  // (4-1) and a clock-skewed (9-10 -> 0): average 1.5. The third has no record of stage 2.
  assert.equal(funnel.stages[1]!.averageDaysFromPrevious, 1.5);
});

await test('nobody registered: an empty funnel, not an error', () => {
  const funnel = funnelOf([]);
  assert.equal(funnel.total, 0);
  assert.ok(funnel.stages.every((s) => s.count === 0 && s.ofRegistered === 0));
});

const asked: unknown[] = [];
const service = new FunnelService({
  people: async (_a: string, scope: unknown) => {
    asked.push(scope);
    return [person(1, 2)];
  },
} as unknown as Pick<FunnelDbService, 'people'>);
const as = (accountId: string, role: 'admin' | 'agent' | 'member') => ({
  agencyId: agency,
  accountId,
  role,
});

await test('an admin reads the whole agency or one agent; an agent only their own clients', async () => {
  await service.report(as(ADMIN, 'admin'), {});
  assert.deepEqual(asked.at(-1), { from: null, to: null, agentId: null });
  await service.report(as(ADMIN, 'admin'), { agentId: KAMAL, from: '2026-10-01' });
  assert.deepEqual(asked.at(-1), { from: '2026-10-01', to: null, agentId: KAMAL });
  // An agent is always scoped to themselves, whatever they ask for.
  await service.report(as(SALMA, 'agent'), {});
  assert.deepEqual(asked.at(-1), { from: null, to: null, agentId: SALMA });
  await service.report(as(SALMA, 'agent'), { agentId: SALMA });
  await assert.rejects(
    service.report(as(SALMA, 'agent'), { agentId: KAMAL }),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(service.report(as(MEMBER, 'member'), {}), code(403, 'ROLE_FORBIDDEN'));
});

await test('the dates must be real dates, and nothing else is accepted', () => {
  assert.equal(funnelQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success, true);
  assert.equal(funnelQuerySchema.safeParse({ from: 'last week' }).success, false);
  assert.equal(funnelQuerySchema.safeParse({ agentId: 'not-an-id' }).success, false);
  assert.equal(funnelQuerySchema.safeParse({ x: 1 }).success, false);
});
