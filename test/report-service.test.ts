import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportService, yearOf, yearSpan } from '../src/service/report-service.js';
import type { ReportRepository } from '../src/db/raw/repository/report-repository.js';
import { AppError } from '../src/exception/app-error.js';
import { agency, accountId } from './fixtures.js';

const actor = (role: 'admin' | 'agent' | 'member') => ({ agencyId: agency, accountId, role });
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('the financial year runs from July to June and is named by the year it starts in', () => {
  assert.deepEqual(yearSpan('fiscal', 2026).months, [
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10',
    '2026-11',
    '2026-12',
    '2027-01',
    '2027-02',
    '2027-03',
    '2027-04',
    '2027-05',
    '2027-06',
  ]);
  assert.equal(yearSpan('fiscal', 2026).from, '2026-07-01');
  assert.equal(yearSpan('fiscal', 2026).to, '2027-07-01');
  assert.equal(yearSpan('calendar', 2026).from, '2026-01-01');
  assert.equal(yearSpan('calendar', 2026).to, '2027-01-01');
  assert.equal(yearSpan('calendar', 2026).months.at(-1), '2026-12');
});

await test('a date belongs to the financial year that started in July before it', () => {
  assert.equal(yearOf('fiscal', '2026-06-30'), 2025);
  assert.equal(yearOf('fiscal', '2026-07-01'), 2026);
  assert.equal(yearOf('fiscal', '2027-01-15'), 2026);
  assert.equal(yearOf('calendar', '2026-06-30'), 2026);
});

await test('only an admin may read the reports', async () => {
  const service = new ReportService(
    {
      transaction: async () => {
        throw new Error('must not be reached');
      },
    },
    {} as ReportRepository,
  );
  for (const role of ['agent', 'member'] as const) {
    await assert.rejects(
      service.summary(actor(role), { basis: 'fiscal' }),
      code(403, 'ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      service.proposals(actor(role), { limit: 10 }),
      code(403, 'ROLE_FORBIDDEN'),
    );
    await assert.rejects(service.network(actor(role), null), code(403, 'ROLE_FORBIDDEN'));
  }
});

await test('a damaged page cursor is refused', async () => {
  const service = new ReportService(
    {
      transaction: async () => {
        throw new Error('must not be reached');
      },
    },
    {} as ReportRepository,
  );
  await assert.rejects(
    service.proposals(actor('admin'), { limit: 10, after: 'not-a-cursor' }),
    code(400, 'INVALID_REQUEST'),
  );
});
