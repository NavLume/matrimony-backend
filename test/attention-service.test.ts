import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttentionItem } from '../src/bo/attention.js';
import type { AttentionUnit } from '../src/db/service/attention-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { AttentionService, workloadOf } from '../src/service/attention-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SALMA = ID(11);
const KAMAL = ID(12);
const now = new Date('2026-10-21T00:00:00Z');
const actor = (role: ProfileActor['role'], accountId: string): ProfileActor => ({
  agencyId: agency,
  accountId,
  role,
});

const item = (agentId: string | null, since: string): AttentionItem => ({
  kind: 'no_candidates',
  since,
  client: { id: ID(200), memberCode: 'M1', fullName: 'Rahim' },
  with: null,
  agent: agentId ? { id: agentId, displayName: 'Agent' } : null,
});

await test('the workload counts each agent’s overdue items and how long the oldest has waited', () => {
  const lines = workloadOf(
    [
      { agentId: SALMA, displayName: 'Salma', clients: 4 },
      { agentId: KAMAL, displayName: 'Kamal', clients: 2 },
    ],
    [
      item(SALMA, '2026-10-10T00:00:00Z'),
      item(SALMA, '2026-10-18T00:00:00Z'),
      item(null, '2026-10-01T00:00:00Z'),
    ],
    now,
  );
  assert.deepEqual(lines[0], {
    agentId: SALMA,
    displayName: 'Salma',
    clients: 4,
    overdue: 2,
    oldestDays: 11,
  });
  assert.deepEqual(lines[1], {
    agentId: KAMAL,
    displayName: 'Kamal',
    clients: 2,
    overdue: 0,
    oldestDays: null,
  });
});

function setup() {
  const asked: (string | null)[] = [];
  const usedLimits: unknown[] = [];
  const unit: AttentionUnit = {
    limits: async () => ({
      reviewDays: 2,
      unansweredDays: 5,
      noCandidatesDays: 3,
      noMeetingDays: 7,
    }),
    items: async (_a, agent, limits) => {
      asked.push(agent);
      usedLimits.push(limits);
      return [item(SALMA, '2026-10-10T00:00:00Z')];
    },
    agents: async () => [{ agentId: SALMA, displayName: 'Salma', clients: 1 }],
  };
  return {
    asked,
    usedLimits,
    service: new AttentionService({ inTransaction: async (_a, work) => work(unit) }, () => now),
  };
}

await test('an agent sees only their own clients and no workload; an admin sees everyone with the workload', async () => {
  const { service, asked } = setup();
  const own = await service.get(actor('agent', SALMA));
  assert.deepEqual(own.workload, []);
  const all = await service.get(actor('admin', ID(1)));
  assert.equal(all.workload.length, 1);
  assert.deepEqual(asked, [SALMA, null]);
});

await test('members and guardians are refused', async () => {
  const { service } = setup();
  for (const role of ['member', 'guardian'] as const)
    await assert.rejects(
      service.get(actor(role, ID(21))),
      (e) => e instanceof AppError && e.status === 403,
    );
});

await test('the agency’s own limits are what the list is built with', async () => {
  const { service, usedLimits } = setup();
  await service.get(actor('admin', ID(1)));
  assert.deepEqual(usedLimits[0], {
    reviewDays: 2,
    unansweredDays: 5,
    noCandidatesDays: 3,
    noMeetingDays: 7,
  });
});
