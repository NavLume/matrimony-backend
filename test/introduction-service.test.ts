import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introductionRangeSchema } from '../src/bo/introduction.js';
import type { IntroductionUnit } from '../src/db/service/introduction-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { IntroductionService } from '../src/service/introduction-service.js';

const agency = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222221';
const SALMA = '22222222-2222-4222-8222-222222222222';
const KAMAL = '22222222-2222-4222-8222-222222222223';
const OTHER = '22222222-2222-4222-8222-222222222224';
const CONNECTION = '44444444-4444-4444-8444-444444444441';
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const ranges: [string | null, string | null][] = [];
const unit = {
  parties: async (_a: string, id: string) =>
    id === CONNECTION
      ? { senderId: 's', recipientId: 'r', senderAgent: SALMA, recipientAgent: KAMAL }
      : null,
  history: async (_a: string, id: string) => ({ connectionId: id, sides: [], events: [] }),
  byAgent: async (_a: string, from: string | null, to: string | null) => {
    ranges.push([from, to]);
    return [];
  },
} as unknown as IntroductionUnit;
const service = new IntroductionService({ inTransaction: async (_a, work) => work(unit) });
const as = (accountId: string, role: 'admin' | 'agent' | 'member') => ({
  agencyId: agency,
  accountId,
  role,
});

await test('an admin, or the agent of either side, reads the history of a proposal; no one else', async () => {
  await service.history(as(ADMIN, 'admin'), CONNECTION);
  await service.history(as(SALMA, 'agent'), CONNECTION);
  await service.history(as(KAMAL, 'agent'), CONNECTION);
  await assert.rejects(
    service.history(as(OTHER, 'agent'), CONNECTION),
    code(404, 'CONNECTION_NOT_FOUND'),
  );
  await assert.rejects(
    service.history(as(ADMIN, 'admin'), '44444444-4444-4444-8444-444444444499'),
    code(404, 'CONNECTION_NOT_FOUND'),
  );
  await assert.rejects(
    service.history(as(SALMA, 'member'), CONNECTION),
    code(403, 'ROLE_FORBIDDEN'),
  );
});

await test('only an admin reads the per-agent report, and the dates are passed through', async () => {
  await assert.rejects(service.byAgent(as(SALMA, 'agent'), {}), code(403, 'ROLE_FORBIDDEN'));
  await service.byAgent(as(ADMIN, 'admin'), {});
  await service.byAgent(as(ADMIN, 'admin'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(ranges, [
    [null, null],
    ['2026-10-01', '2026-10-31'],
  ]);
});

await test('the date range must be real dates, and nothing else is accepted', () => {
  assert.equal(introductionRangeSchema.safeParse({ from: '2026-10-01' }).success, true);
  assert.equal(introductionRangeSchema.safeParse({}).success, true);
  assert.equal(introductionRangeSchema.safeParse({ from: 'yesterday' }).success, false);
  assert.equal(introductionRangeSchema.safeParse({ agent: 'x' }).success, false);
});
