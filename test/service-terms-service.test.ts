import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { ServiceTerms } from '../src/bo/service-terms.js';
import type { TermsProfile } from '../src/db/raw/repository/service-terms-repository.js';
import type { ServiceTermsUnit } from '../src/db/service/service-terms-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import { ServiceTermsService } from '../src/service/service-terms-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SALMA = ID(11);
const KAMAL = ID(12);
const ADMIN = ID(1);
const MEMBER = ID(21);
const OTHER_MEMBER = ID(22);
const CLIENT = ID(201);

const actor = (role: ProfileActor['role'], accountId: string): ProfileActor => ({
  agencyId: agency,
  accountId,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const input = {
  coverage: 'Search, introductions and meetings for six months',
  introductions: 6,
  refundRule: 'Half of the registration fee is returned if no introduction is made in 60 days',
};

function setup(profile: Partial<TermsProfile> = {}) {
  const versions: ServiceTerms[] = [];
  const events: WorkflowEvent[] = [];
  const found: TermsProfile = {
    id: CLIENT,
    memberCode: 'M1',
    fullName: 'Rahim',
    assignedAgentId: SALMA,
    ownerAccountId: MEMBER,
    ...profile,
  };
  const unit: ServiceTermsUnit = {
    profileById: async (_a, id) => (id === found.id ? found : null),
    ownProfile: async (_a, account) => (account === found.ownerAccountId ? found : null),
    versions: async () => [...versions].reverse(),
    insert: async (_a, _p, value, by) => {
      versions.push({
        version: versions.length + 1,
        coverage: value.coverage,
        introductions: value.introductions,
        refundRule: value.refundRule,
        recordedBy: by,
        recordedAt: '2026-10-21T10:00:00.000Z',
        acknowledged: null,
      });
      return versions.length;
    },
    acknowledge: async (_a, _p, by, how) => {
      const newest = versions[versions.length - 1];
      if (!newest || newest.acknowledged) return false;
      newest.acknowledged = { at: '2026-10-21T11:00:00.000Z', by, how };
      return true;
    },
    appendEvent: async (event) => void events.push(event),
  };
  const service = new ServiceTermsService(
    { inTransaction: async (_agency, work) => work(unit) },
    () => new Date('2026-10-21T10:00:00Z'),
    () => ID(900 + events.length),
  );
  return { service, versions, events };
}

await test('the agent records the terms and the client sees them, without the history', async () => {
  const { service, events } = setup();
  const staff = await service.record(actor('agent', SALMA), CLIENT, input, 'c');
  assert.equal(staff.current?.version, 1);
  assert.equal(staff.history.length, 1);
  assert.equal(events[0]?.type, 'service_terms.recorded');

  const own = await service.state(actor('member', MEMBER), { kind: 'own' });
  assert.equal(own.current?.coverage, input.coverage);
  assert.deepEqual(own.history, []);
});

await test('a change is a new version and asks the client to confirm again', async () => {
  const { service } = setup();
  await service.record(actor('agent', SALMA), CLIENT, input, 'c');
  const confirmed = await service.acknowledge(actor('member', MEMBER), { kind: 'own' }, 'c');
  assert.equal(confirmed.current?.acknowledged?.how, 'client');

  const changed = await service.record(
    actor('admin', ADMIN),
    CLIENT,
    { ...input, introductions: null },
    'c',
  );
  assert.equal(changed.current?.version, 2);
  assert.equal(changed.current?.acknowledged, null);
  // The earlier version is kept exactly as it was, with its confirmation.
  assert.equal(changed.history[1]?.acknowledged?.how, 'client');
});

await test('the agent can record that the client agreed in the office, once', async () => {
  const { service } = setup({ ownerAccountId: null });
  await service.record(actor('agent', SALMA), CLIENT, input, 'c');
  const state = await service.acknowledge(
    actor('agent', SALMA),
    { kind: 'client', profileId: CLIENT },
    'c',
  );
  assert.equal(state.current?.acknowledged?.how, 'office');
  await assert.rejects(
    service.acknowledge(actor('agent', SALMA), { kind: 'client', profileId: CLIENT }, 'c'),
    code(409, 'TERMS_ALREADY_CONFIRMED'),
  );
});

await test('there is nothing to confirm until the terms are recorded', async () => {
  const { service } = setup();
  await assert.rejects(
    service.acknowledge(actor('member', MEMBER), { kind: 'own' }, 'c'),
    code(404, 'TERMS_NOT_FOUND'),
  );
  const empty = await service.state(actor('member', MEMBER), { kind: 'own' });
  assert.equal(empty.current, null);
});

await test('only the staff who look after the client record terms, and only the client confirms their own', async () => {
  const { service } = setup();
  await assert.rejects(
    service.record(actor('agent', KAMAL), CLIENT, input, 'c'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    service.record(actor('member', MEMBER), CLIENT, input, 'c'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    service.state(actor('member', OTHER_MEMBER), { kind: 'own' }),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    service.state(actor('agent', SALMA), { kind: 'own' }),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    service.acknowledge(actor('member', MEMBER), { kind: 'client', profileId: CLIENT }, 'c'),
    code(403, 'ROLE_FORBIDDEN'),
  );
});
