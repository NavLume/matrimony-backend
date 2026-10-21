import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/exception/app-error.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { PrivacyUnit } from '../src/db/service/privacy-db-service.js';
import { PrivacyService } from '../src/service/privacy-service.js';

const agency = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222221';
const NASRIN = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222223';
const MEMBER = '22222222-2222-4222-8222-222222222224';
const OWN_PROFILE = '33333333-3333-4333-8333-333333333331';
const ASSISTED = '33333333-3333-4333-8333-333333333332';
const LOGIN_CLIENT = '33333333-3333-4333-8333-333333333333';

const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const empty = {
  account: null,
  profile: { full_name: 'x' },
  contact: null,
  partnerPreferences: null,
  photos: [],
  cv: [],
  verification: [],
  guardians: [],
  proposals: [],
  meetings: [],
  agreedAmounts: [],
  payments: [],
  serviceTerms: [],
  concerns: [],
  messages: [],
};

function fixture() {
  const events: WorkflowEvent[] = [];
  const scheduled: { id: string; reason: string }[] = [];
  const cancelled: string[] = [];
  const collected: (string | null)[] = [];
  const subjects: Record<string, { assisted: boolean; agent: string | null; code: string }> = {
    [OWN_PROFILE]: { assisted: false, agent: NASRIN, code: 'M1000001' },
    [ASSISTED]: { assisted: true, agent: NASRIN, code: 'M1000002' },
    [LOGIN_CLIENT]: { assisted: false, agent: NASRIN, code: 'M1000003' },
  };
  const unit = {
    subject: async (_a: string, id: string) => {
      const s = subjects[id];
      return s
        ? {
            id,
            memberCode: s.code,
            name: 'Someone',
            assisted: s.assisted,
            ownerAccountId: s.assisted ? null : MEMBER,
            assignedAgentId: s.agent,
          }
        : null;
    },
    profileOf: async () => OWN_PROFILE,
    consents: async () => [
      {
        purpose: 'terms',
        documentVersion: 'v1',
        action: 'accepted',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    collect: async (_a: string, _p: string, account: string | null) => {
      collected.push(account);
      return empty;
    },
    appendEvent: async (event: WorkflowEvent) => {
      events.push(event);
    },
  } as unknown as PrivacyUnit;
  const service = new PrivacyService(
    { inTransaction: async (_agency, work) => work(unit) },
    {
      scheduleClient: async (_actor, id, reason) => {
        scheduled.push({ id, reason });
        return new Date('2026-10-28T10:00:00.000Z');
      },
      cancelClient: async (_actor, id) => {
        cancelled.push(id);
        return true;
      },
    },
    () => new Date('2026-10-21T10:00:00.000Z'),
    () => '44444444-4444-4444-8444-444444444444',
  );
  return { service, events, scheduled, cancelled, collected };
}

const as = (accountId: string, role: 'admin' | 'agent' | 'member') => ({
  agencyId: agency,
  accountId,
  role,
});

await test('a member gets a copy of their own data, which is recorded, and the other side is not named', async () => {
  const f = fixture();
  const copy = await f.service.myExport(as(MEMBER, 'member'), 'req');
  assert.equal(copy.subject.kind, 'member');
  assert.equal(copy.generatedAt, '2026-10-21T10:00:00.000Z');
  assert.equal(copy.consents.length, 1);
  assert.equal('staffNotes' in copy, false);
  assert.deepEqual(f.collected, [MEMBER]);
  assert.equal(f.events[0]?.type, 'account.data_exported');
});

await test('only a member reads their own consents and copy', async () => {
  const f = fixture();
  await assert.rejects(f.service.myExport(as(NASRIN, 'agent'), 'r'), code(403, 'ROLE_FORBIDDEN'));
  await assert.rejects(f.service.myConsents(as(ADMIN, 'admin')), code(403, 'ROLE_FORBIDDEN'));
  assert.equal((await f.service.myConsents(as(MEMBER, 'member'))).length, 1);
});

await test("the client's own agent or an admin can copy a client with no login, another agent cannot", async () => {
  const f = fixture();
  const copy = await f.service.clientExport(as(NASRIN, 'agent'), ASSISTED, 'r');
  assert.equal(copy.subject.kind, 'client_without_login');
  assert.deepEqual(f.collected, [null]);
  assert.equal(f.events[0]?.type, 'client.data_exported');
  await f.service.clientExport(as(ADMIN, 'admin'), ASSISTED, 'r');
  await assert.rejects(
    f.service.clientExport(as(OTHER_AGENT, 'agent'), ASSISTED, 'r'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    f.service.clientConsents(as(OTHER_AGENT, 'agent'), ASSISTED),
    code(404, 'PROFILE_NOT_FOUND'),
  );
});

await test('a client who has a login is not copied by staff: they can do it themselves', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.clientExport(as(NASRIN, 'agent'), LOGIN_CLIENT, 'r'),
    code(409, 'CLIENT_HAS_LOGIN'),
  );
  await assert.rejects(
    f.service.clientConsents(as(ADMIN, 'admin'), LOGIN_CLIENT),
    code(409, 'CLIENT_HAS_LOGIN'),
  );
  assert.deepEqual(f.events, []);
});

await test('asking to erase a client with no login is for admins, with the member code and a reason', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.scheduleErasure(as(NASRIN, 'agent'), ASSISTED, 'M1000002', 'The family asked', 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    f.service.scheduleErasure(as(ADMIN, 'admin'), ASSISTED, 'M9999999', 'The family asked', 'r'),
    code(400, 'CODE_MISMATCH'),
  );
  assert.deepEqual(f.scheduled, []);
  const result = await f.service.scheduleErasure(
    as(ADMIN, 'admin'),
    ASSISTED,
    'm1000002',
    'The family asked',
    'r',
  );
  assert.equal(result.erasesOn, '2026-10-28T10:00:00.000Z');
  assert.deepEqual(f.scheduled, [{ id: ASSISTED, reason: 'The family asked' }]);
});

await test('a client who has a login, or who does not exist, cannot be scheduled by an admin', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.scheduleErasure(
      as(ADMIN, 'admin'),
      LOGIN_CLIENT,
      'M1000003',
      'The family asked',
      'r',
    ),
    code(409, 'CLIENT_HAS_LOGIN'),
  );
  await assert.rejects(
    f.service.scheduleErasure(
      as(ADMIN, 'admin'),
      '33333333-3333-4333-8333-333333333399',
      'M1',
      'The family asked',
      'r',
    ),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  assert.deepEqual(f.scheduled, []);
});

await test('only an admin cancels a scheduled erasure', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.cancelErasure(as(NASRIN, 'agent'), ASSISTED, 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await f.service.cancelErasure(as(ADMIN, 'admin'), ASSISTED, 'r');
  assert.deepEqual(f.cancelled, [ASSISTED]);
});
