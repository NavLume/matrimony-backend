import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { profileInputSchema } from '../src/bo/profile.js';
import type { ProfileRecord } from '../src/bo/profile-state.js';
import type { CandidateUnit } from '../src/db/service/candidate-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { CandidateService } from '../src/service/candidate-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';

const agencyId = '11111111-1111-4111-8111-111111111111';
const agent: ProfileActor = {
  agencyId,
  accountId: '33333333-3333-4333-8333-333333333333',
  role: 'agent',
};
const stranger: ProfileActor = {
  agencyId,
  accountId: '55555555-5555-4555-8555-555555555555',
  role: 'agent',
};
const member: ProfileActor = {
  agencyId,
  accountId: '44444444-4444-4444-8444-444444444444',
  role: 'member',
};
const today = new Date(Date.UTC(2026, 9, 10));

const client = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'active',
  assignedAgentId: agent.accountId,
  data: profileInputSchema(today).parse({ profile: { fullName: 'C', gender: 'male' } }),
} as unknown as ProfileRecord;

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

type Start = {
  /** Candidate states, and whether each candidate is still published. */
  states?: Record<string, string>;
  unpublished?: string[];
  /** Where the client stands before matching; ready unless a test says otherwise. */
  readiness?: { agreementRecorded: boolean; verified: boolean; override?: boolean };
  settings?: { cap: number; visibleFields: string[]; allowCodeSearch?: boolean };
};

/** An in-memory unit that keeps candidate states, settings and events, so a test sees what happened. */
function fake(start: Start = {}) {
  const states = new Map<string, string>(Object.entries(start.states ?? {}));
  const unpublished = new Set(start.unpublished ?? []);
  let settings = start.settings ? { ...start.settings } : null;
  const events: string[] = [];
  const unit = {
    lockClient: async () => client,
    readClient: async () => client,
    settings: async () => settings,
    saveSettings: async (
      _a: string,
      _c: string,
      input: { cap: number; visibleFields: readonly string[]; allowCodeSearch: boolean },
    ) => {
      settings = {
        cap: input.cap,
        visibleFields: [...input.visibleFields],
        allowCodeSearch: input.allowCodeSearch,
      };
    },
    releasedCount: async () => [...states.values()].filter((v) => v === 'released').length,
    releasable: async (_a: string, _c: string, wanted: readonly string[]) =>
      wanted.filter((id) => states.get(id) === 'proposed' && !unpublished.has(id)),
    markReleased: async (_a: string, _c: string, wanted: readonly string[]) => {
      const moved = wanted.filter((id) => states.get(id) === 'proposed');
      for (const id of moved) states.set(id, 'released');
      return moved;
    },
    markRemoved: async (_a: string, _c: string, wanted: readonly string[]) => {
      const moved = wanted.filter((id) =>
        ['proposed', 'lapsed', 'released'].includes(states.get(id) ?? ''),
      );
      for (const id of moved) states.set(id, 'removed');
      return moved;
    },
    readiness: async () => {
      const r = start.readiness ?? { agreementRecorded: true, verified: true };
      const override = r.override ? { at: today.toISOString(), reason: 'Test', by: null } : null;
      return { ...r, override, ready: (r.agreementRecorded && r.verified) || override !== null };
    },
    setOverride: async () => {
      start.readiness = {
        ...(start.readiness ?? { agreementRecorded: false, verified: false }),
        override: true,
      };
    },
    appendEvent: async (event: { type: string }) => {
      events.push(event.type);
    },
  } as unknown as CandidateUnit;
  const service = new CandidateService(
    { inTransaction: async (_agency, work) => work(unit) },
    pino({ level: 'silent' }),
    () => today,
  );
  return { service, states, events, settings: () => settings };
}

const refused = (status: number, code?: string) => (e: unknown) =>
  e instanceof AppError && e.status === status && (code === undefined || e.code === code);

await test('without settings a client gets the defaults, and the window count is shown', async () => {
  const [a] = ids(1) as [string];
  const { service } = fake({ states: { [a]: 'released' } });
  const settings = await service.settings(agent, client.id);
  assert.equal(settings.cap, 50);
  assert.equal(settings.isDefault, true);
  assert.equal(settings.releasedCount, 1);
  assert.ok(settings.visibleFields.includes('fullName'));
  assert.ok(!settings.visibleFields.includes('hobbies'));
});

await test('only proposed, still published profiles are released; the rest are reported as skipped', async () => {
  const [a, b, c, gone, unknown] = ids(5) as [string, string, string, string, string];
  const t = fake({
    states: { [a]: 'proposed', [b]: 'removed', [c]: 'proposed', [gone]: 'proposed' },
    unpublished: [gone],
  });
  const outcome = await t.service.release(
    agent,
    client.id,
    { candidateIds: [a, b, c, gone, unknown] },
    'r',
  );
  assert.deepEqual(outcome.done, [a, c]);
  assert.deepEqual(outcome.skipped, [b, gone, unknown]);
  assert.equal(t.states.get(b), 'removed');
  assert.deepEqual(t.events, ['candidates.released']);
});

await test('the window is never exceeded: too many at once releases nothing', async () => {
  const [a, b, c] = ids(3) as [string, string, string];
  const t = fake({
    states: { [a]: 'proposed', [b]: 'proposed', [c]: 'proposed' },
    settings: { cap: 2, visibleFields: ['fullName'] },
  });
  await assert.rejects(
    t.service.release(agent, client.id, { candidateIds: [a, b, c] }, 'r'),
    (e) => refused(409, 'CAP_REACHED')(e) && (e as AppError).details?.room === 2,
  );
  assert.equal([...t.states.values()].filter((v) => v === 'released').length, 0);
  assert.equal(t.events.length, 0);
  // Two fit; then the window is full.
  await t.service.release(agent, client.id, { candidateIds: [a, b] }, 'r');
  await assert.rejects(
    t.service.release(agent, client.id, { candidateIds: [c] }, 'r'),
    (e) => refused(409, 'CAP_REACHED')(e) && (e as AppError).details?.room === 0,
  );
});

await test('removing frees a place in the window, and a removed profile cannot be removed again', async () => {
  const [a, b] = ids(2) as [string, string];
  const t = fake({
    states: { [a]: 'released', [b]: 'proposed' },
    settings: { cap: 1, visibleFields: ['fullName'] },
  });
  await assert.rejects(
    t.service.release(agent, client.id, { candidateIds: [b] }, 'r'),
    refused(409, 'CAP_REACHED'),
  );
  assert.deepEqual((await t.service.remove(agent, client.id, { candidateIds: [a] }, 'r')).done, [
    a,
  ]);
  assert.deepEqual((await t.service.remove(agent, client.id, { candidateIds: [a] }, 'r')).skipped, [
    a,
  ]);
  assert.deepEqual((await t.service.release(agent, client.id, { candidateIds: [b] }, 'r')).done, [
    b,
  ]);
  assert.deepEqual(t.events, ['candidates.removed', 'candidates.released']);
});

await test('the cap cannot go below what is released; saved settings record an event', async () => {
  const [a, b] = ids(2) as [string, string];
  const t = fake({ states: { [a]: 'released', [b]: 'released' } });
  await assert.rejects(
    t.service.saveSettings(
      agent,
      client.id,
      { cap: 1, visibleFields: ['fullName'], allowCodeSearch: false },
      'c',
    ),
    (e) => refused(409, 'CAP_BELOW_RELEASED')(e) && (e as AppError).details?.released === 2,
  );
  const saved = await t.service.saveSettings(
    agent,
    client.id,
    { cap: 80, visibleFields: ['fullName', 'photo'], allowCodeSearch: false },
    'c',
  );
  assert.equal(saved.cap, 80);
  assert.equal(saved.isDefault, false);
  assert.deepEqual(t.settings(), {
    cap: 80,
    visibleFields: ['fullName', 'photo'],
    allowCodeSearch: false,
  });
  assert.deepEqual(t.events, ['candidates.settings_changed']);
});

await test('only staff who manage the client change what it sees', async () => {
  const { service } = fake();
  const one = { candidateIds: ids(1) };
  const settings = { cap: 5, visibleFields: ['fullName' as const], allowCodeSearch: false };
  for (const act of [
    () => service.settings(member, client.id),
    () => service.saveSettings(member, client.id, settings, 'c'),
    () => service.release(member, client.id, one, 'c'),
    () => service.remove(member, client.id, one, 'c'),
  ])
    await assert.rejects(act(), refused(403));
  for (const act of [
    () => service.settings(stranger, client.id),
    () => service.saveSettings(stranger, client.id, settings, 'c'),
    () => service.release(stranger, client.id, one, 'c'),
    () => service.remove(stranger, client.id, one, 'c'),
  ])
    await assert.rejects(act(), refused(404));
});

await test('matching starts only when the agreed amount is recorded and the document verified', async () => {
  const [a] = ids(1) as [string];
  const one = { candidateIds: [a] };
  for (const readiness of [
    { agreementRecorded: false, verified: true },
    { agreementRecorded: true, verified: false },
    { agreementRecorded: false, verified: false },
  ]) {
    const { service, states } = fake({ states: { [a]: 'proposed' }, readiness });
    await assert.rejects(service.generate(agent, client.id), refused(409, 'MATCHING_NOT_READY'));
    await assert.rejects(
      service.release(agent, client.id, one, 'c'),
      refused(409, 'MATCHING_NOT_READY'),
    );
    assert.equal(states.get(a), 'proposed');
    // Removing a candidate and reading are not matching work.
    assert.equal((await service.remove(agent, client.id, one, 'c')).done.length, 1);
  }
  const ready = fake({ states: { [a]: 'proposed' } });
  assert.deepEqual((await ready.service.release(agent, client.id, one, 'c')).done, [a]);
});

await test('only an admin lets a client through, with a reason, and it is recorded', async () => {
  const [a] = ids(1) as [string];
  const t = fake({
    states: { [a]: 'proposed' },
    readiness: { agreementRecorded: false, verified: false },
  });
  const admin: ProfileActor = { ...agent, role: 'admin' };
  await assert.rejects(
    t.service.overrideReadiness(agent, client.id, { reason: 'Known family' }, 'c'),
    refused(403),
  );
  await assert.rejects(
    t.service.release(agent, client.id, { candidateIds: [a] }, 'c'),
    refused(409, 'MATCHING_NOT_READY'),
  );
  const state = await t.service.overrideReadiness(
    admin,
    client.id,
    { reason: 'Known family' },
    'c',
  );
  assert.equal(state.ready, true);
  assert.deepEqual(t.events, ['candidates.ready_override']);
  assert.deepEqual((await t.service.release(agent, client.id, { candidateIds: [a] }, 'c')).done, [
    a,
  ]);
});

await test('staff can read where a client stands, and only for their own clients', async () => {
  const t = fake({ readiness: { agreementRecorded: true, verified: false } });
  const state = await t.service.readiness(agent, client.id);
  assert.deepEqual([state.ready, state.agreementRecorded, state.verified], [false, true, false]);
  await assert.rejects(t.service.readiness(member, client.id), refused(403));
  await assert.rejects(t.service.readiness(stranger, client.id), refused(404));
});
