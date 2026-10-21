import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/exception/app-error.js';
import type { DeclineUnit } from '../src/db/service/decline-db-service.js';
import { DeclineService } from '../src/service/decline-service.js';

const agency = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222221';
const NASRIN = '22222222-2222-4222-8222-222222222222';
const OTHER = '22222222-2222-4222-8222-222222222223';
const CLIENT = '33333333-3333-4333-8333-333333333331';
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const asked: (string | null)[] = [];
const unit = {
  clientOf: async (_a: string, id: string) => (id === CLIENT ? { assignedAgentId: NASRIN } : null),
  patterns: async (_a: string, id: string | null) => {
    asked.push(id);
    return { total: 3, items: [{ reason: 'location', proposals: 2, meetings: 1 }] };
  },
} as unknown as DeclineUnit;
const service = new DeclineService({ inTransaction: async (_a, work) => work(unit) });
const as = (accountId: string, role: 'admin' | 'agent' | 'member') => ({
  agencyId: agency,
  accountId,
  role,
});

await test("an admin or the client's own agent reads a client's patterns, no one else", async () => {
  assert.equal((await service.forClient(as(NASRIN, 'agent'), CLIENT)).total, 3);
  await service.forClient(as(ADMIN, 'admin'), CLIENT);
  assert.deepEqual(asked, [CLIENT, CLIENT]);
  await assert.rejects(
    service.forClient(as(OTHER, 'agent'), CLIENT),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    service.forClient(as(ADMIN, 'admin'), '33333333-3333-4333-8333-333333333399'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    service.forClient(as(CLIENT, 'member'), CLIENT),
    code(403, 'ROLE_FORBIDDEN'),
  );
});

await test("only an admin reads the whole agency's patterns", async () => {
  asked.length = 0;
  await service.forAgency(as(ADMIN, 'admin'));
  assert.deepEqual(asked, [null]);
  await assert.rejects(service.forAgency(as(NASRIN, 'agent')), code(403, 'ROLE_FORBIDDEN'));
});
