import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Journey } from '../src/bo/journey.js';
import type { JourneyProfile } from '../src/db/raw/repository/journey-repository.js';
import type { JourneyUnit } from '../src/db/service/journey-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { JourneyService } from '../src/service/journey-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SALMA = ID(11);
const KAMAL = ID(12);
const ADMIN = ID(1);
const MEMBER = ID(21);
const CLIENT = ID(201);
const actor = (role: ProfileActor['role'], accountId: string): ProfileActor => ({
  agencyId: agency,
  accountId,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const profile: JourneyProfile = {
  id: CLIENT,
  memberCode: 'M1',
  fullName: 'Rahim',
  status: 'active',
  assignedAgentId: SALMA,
  ownerAccountId: MEMBER,
};
const empty = (staff: boolean): Journey => ({
  profile: { id: CLIENT, memberCode: 'M1', fullName: staff ? 'Rahim' : 'Rahim', status: 'active' },
  summary: { released: 0, proposalsSent: 0, proposalsReceived: 0, accepted: 0, meetings: 0 },
  waiting: { onAgency: [], onYou: [], onOthers: [] },
  events: [],
});

function setup() {
  const asked: { staff: boolean }[] = [];
  const unit: JourneyUnit = {
    profileById: async (_a, id) => (id === CLIENT ? profile : null),
    ownProfile: async (_a, account) => (account === MEMBER ? profile : null),
    journey: async (_a, _p, staff) => {
      asked.push({ staff });
      return empty(staff);
    },
  };
  return { service: new JourneyService({ inTransaction: async (_a, work) => work(unit) }), asked };
}

await test('a member reads their own journey, without names the rules hide', async () => {
  const { service, asked } = setup();
  const own = await service.get(actor('member', MEMBER), { kind: 'own' });
  assert.equal(own.profile.id, CLIENT);
  assert.deepEqual(asked, [{ staff: false }]);
});

await test('the agent of a client and an admin read the journey with names; another agent gets not found', async () => {
  const { service, asked } = setup();
  const target = { kind: 'client' as const, profileId: CLIENT };
  await service.get(actor('agent', SALMA), target);
  await service.get(actor('admin', ADMIN), target);
  assert.deepEqual(asked, [{ staff: true }, { staff: true }]);
  await assert.rejects(service.get(actor('agent', KAMAL), target), code(404, 'PROFILE_NOT_FOUND'));
});

await test('members and staff cannot use each other’s way in', async () => {
  const { service } = setup();
  await assert.rejects(
    service.get(actor('member', MEMBER), { kind: 'client', profileId: CLIENT }),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    service.get(actor('agent', SALMA), { kind: 'own' }),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    service.get(actor('member', ID(99)), { kind: 'own' }),
    code(404, 'PROFILE_NOT_FOUND'),
  );
});
