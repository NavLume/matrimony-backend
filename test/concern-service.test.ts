import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConcernRow, MyConcern } from '../src/bo/concern.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { ConcernUnit } from '../src/db/service/concern-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { ConcernService } from '../src/service/concern-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = ID(1);
const SALMA = ID(11); // looks after the profile that is reported
const KAMAL = ID(12); // looks after nobody involved
const NASRIN = ID(13); // looks after the member who reports
const ASSISTED = ID(203); // an assisted client of Nasrin, with no login
const LOGIN_CLIENT = ID(204); // a client who has a login
const MEMBER = ID(21);
const OTHER = ID(22);
const PROFILE = ID(201);
const OWN_PROFILE = ID(202);

const actor = (role: ProfileActor['role'], accountId: string): ProfileActor => ({
  agencyId: agency,
  accountId,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

function setup() {
  const stored: (MyConcern & {
    reporter: string | null;
    aboutProfileId: string | null;
    recordedBy?: string;
    forClient?: string;
  })[] = [];
  const told: string[] = [];
  const events: WorkflowEvent[] = [];
  // Who looks after each profile that can be reported.
  const agentOf = new Map<string, string>([[PROFILE, SALMA]]);
  // Who looks after each member who reports.
  const reporterAgent = new Map<string, string>([[MEMBER, NASRIN]]);
  const visibleTo = (c: (typeof stored)[number], agentId: string | null) =>
    agentId === null ||
    (c.about === 'profile' && agentOf.get(c.aboutProfileId!) === agentId) ||
    (c.sharedWithAgent && reporterAgent.get(c.reporter ?? '') === agentId) ||
    c.recordedBy === agentId;
  const unit: ConcernUnit = {
    profileByCode: async (_a, code) => (code.toUpperCase() === 'M1' ? PROFILE : null),
    clientForRecording: async (_a, id) =>
      id === ASSISTED
        ? { id, assisted: true, assignedAgentId: NASRIN }
        : id === LOGIN_CLIENT
          ? { id, assisted: false, assignedAgentId: NASRIN }
          : null,
    insertForClient: async (_a, id, clientId, by, _toldBy, input) => {
      stored.push({
        id,
        about: input.about,
        aboutCode: input.aboutProfileId ? 'M1' : null,
        aboutProfileId: input.aboutProfileId,
        sharedWithAgent: false,
        category: input.category,
        message: input.message,
        status: 'open',
        createdAt: '2026-10-21T10:00:00.000Z',
        resolvedAt: null,
        outcomeNote: null,
        reporter: null,
        recordedBy: by,
        forClient: clientId,
      });
    },
    reportable: async (_a, profileId, account) =>
      profileId === PROFILE && account !== OTHER ? true : false,
    insert: async (_a, id, reporter, input) => {
      stored.push({
        id,
        about: input.about,
        aboutCode: input.profileId ? 'M1' : null,
        aboutProfileId: input.profileId ?? null,
        sharedWithAgent: input.shareWithMyAgent,
        category: input.category,
        message: input.message,
        status: 'open',
        createdAt: '2026-10-21T10:00:00.000Z',
        resolvedAt: null,
        outcomeNote: null,
        reporter,
      });
    },
    mine: async (_a, account) => stored.filter((c) => c.reporter === account),
    list: async (_a, status, agentId) =>
      stored
        .filter((c) => c.status === status && visibleTo(c, agentId))
        .map((c) => ({
          ...c,
          reporter:
            agentId === null ||
            (c.sharedWithAgent && reporterAgent.get(c.reporter ?? '') === agentId) ||
            c.recordedBy === agentId
              ? { name: 'Reporter', memberCode: null }
              : null,
          recorded: c.forClient
            ? {
                forClient: { id: c.forClient, memberCode: 'M9', fullName: 'Rina' },
                by: 'Staff',
                toldBy: 'phone' as const,
              }
            : null,
          aboutProfile: null,
          resolvedBy: null,
        })) as ConcernRow[],
    resolve: async (_a, id, _by, note, agentId) => {
      const found = stored.find((c) => c.id === id && c.status === 'open' && visibleTo(c, agentId));
      if (!found) return { found: false, reporter: null };
      found.status = 'resolved';
      found.outcomeNote = note;
      return { found: true, reporter: found.reporter };
    },
    tellStaff: async (_a, id, reporter) => {
      const c = stored.find((x) => x.id === id)!;
      const agents = [
        c.about === 'profile' ? agentOf.get(c.aboutProfileId!) : undefined,
        c.sharedWithAgent ? reporterAgent.get(reporter) : undefined,
      ].filter((agent) => agent !== undefined && agent !== reporter);
      told.push(`staff:${agents.join('+') || 'admins-only'}`);
    },
    tellReporter: async (_a, id, reporter) => void told.push(`reporter:${reporter}:${id}`),
    appendEvent: async (event) => void events.push(event),
  };
  const service = new ConcernService(
    { inTransaction: async (_a, work) => work(unit) },
    () => new Date('2026-10-21T10:00:00Z'),
    () => ID(900 + stored.length),
  );
  return { service, stored, told, events };
}

const about = {
  about: 'profile' as const,
  profileId: PROFILE,
  category: 'asks_for_money' as const,
  message: 'This person keeps asking me to send money.',
  shareWithMyAgent: false,
};
const aboutAgency = {
  about: 'agency' as const,
  category: 'staff_conduct' as const,
  message: 'An agent pressed me to pay more than we agreed.',
  shareWithMyAgent: false,
};

await test('a member reports a concern, staff are told, and the reporter sees only their own', async () => {
  const { service, told, events } = setup();
  const mine = await service.report(actor('member', MEMBER), about, 'c');
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.status, 'open');
  // The agent who looks after the profile reported is told, as well as the admins.
  assert.deepEqual(told, [`staff:${SALMA}`]);
  assert.equal(events[0]?.type, 'concern.reported');
  assert.deepEqual(await service.mine(actor('member', OTHER)), []);
});

await test('a concern about a profile that cannot be reported is not found; one about the agency needs no profile', async () => {
  const { service } = setup();
  await service.report(actor('member', MEMBER), aboutAgency, 'c');
  await assert.rejects(
    service.report(actor('member', OTHER), { ...about, profileId: OWN_PROFILE }, 'c'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
});

await test('an agent reads only the concerns about their own client, without who reported them', async () => {
  const { service } = setup();
  await service.report(actor('member', MEMBER), about, 'c');
  await service.report(actor('member', MEMBER), aboutAgency, 'c');

  const admin = await service.list(actor('admin', ADMIN), 'open');
  assert.equal(admin.length, 2);
  assert.ok(
    admin.every((c) => c.reporter !== null),
    'the admin sees who reported',
  );

  const salma = await service.list(actor('agent', SALMA), 'open');
  assert.equal(salma.length, 1);
  assert.equal(salma[0]?.about, 'profile');
  assert.equal(salma[0]?.reporter, null);

  // A concern about the agency's staff is never shown to an agent, and another agent sees nothing.
  assert.deepEqual(await service.list(actor('agent', KAMAL), 'open'), []);
});

await test('an agent handles what they can read, and for anything else it does not exist', async () => {
  const { service, told } = setup();
  await service.report(actor('member', MEMBER), about, 'c');
  await service.report(actor('member', MEMBER), aboutAgency, 'c');
  const [profileConcern, agencyConcern] = await service.list(actor('admin', ADMIN), 'open');

  await assert.rejects(
    service.resolve(actor('agent', SALMA), agencyConcern!.id, 'Looked into it.', 'c'),
    code(404, 'CONCERN_NOT_FOUND'),
  );
  await assert.rejects(
    service.resolve(actor('agent', KAMAL), profileConcern!.id, 'Looked into it.', 'c'),
    code(404, 'CONCERN_NOT_FOUND'),
  );
  const left = await service.resolve(
    actor('agent', SALMA),
    profileConcern!.id,
    'I spoke to the family and they were warned.',
    'c',
  );
  assert.equal(left.length, 0);
  assert.ok(told.some((line) => line.startsWith(`reporter:${MEMBER}`)));
  const mine = await service.mine(actor('member', MEMBER));
  assert.equal(
    mine.find((c) => c.about === 'profile')?.outcomeNote,
    'I spoke to the family and they were warned.',
  );
});

await test('an admin handles any concern, once', async () => {
  const { service } = setup();
  await service.report(actor('member', MEMBER), aboutAgency, 'c');
  const [concern] = await service.list(actor('admin', ADMIN), 'open');
  const after = await service.resolve(
    actor('admin', ADMIN),
    concern!.id,
    'We spoke to the agent.',
    'c',
  );
  assert.equal(after.length, 0);
  await assert.rejects(
    service.resolve(actor('admin', ADMIN), concern!.id, 'Again', 'c'),
    code(404, 'CONCERN_NOT_FOUND'),
  );
});

await test('only members report, and members and guardians cannot read the staff list', async () => {
  const { service } = setup();
  for (const role of ['agent', 'admin', 'guardian'] as const)
    await assert.rejects(
      service.report(actor(role, SALMA), about, 'c'),
      code(403, 'ROLE_FORBIDDEN'),
    );
  for (const role of ['member', 'guardian'] as const)
    await assert.rejects(service.list(actor(role, MEMBER), 'open'), code(403, 'ROLE_FORBIDDEN'));
});

await test('the reporter can let their own agent read it too, and then that agent sees who reported', async () => {
  const { service, told } = setup();
  await service.report(actor('member', MEMBER), { ...about, shareWithMyAgent: true }, 'c');
  // Both the agent of the profile reported and the reporter's own agent are told.
  assert.deepEqual(told, [`staff:${SALMA}+${NASRIN}`]);

  const own = await service.list(actor('agent', NASRIN), 'open');
  assert.equal(own.length, 1);
  assert.notEqual(
    own[0]?.reporter,
    null,
    'the reporter chose to share, so their agent sees who it was',
  );
  const reported = await service.list(actor('agent', SALMA), 'open');
  assert.equal(reported[0]?.reporter, null, 'the agent of the person reported still does not');
  assert.deepEqual(await service.list(actor('agent', KAMAL), 'open'), []);
  assert.equal((await service.mine(actor('member', MEMBER)))[0]?.sharedWithAgent, true);
});

await test('by default the reporter’s own agent reads nothing', async () => {
  const { service, told } = setup();
  await service.report(actor('member', MEMBER), about, 'c');
  assert.deepEqual(told, [`staff:${SALMA}`]);
  assert.deepEqual(await service.list(actor('agent', NASRIN), 'open'), []);
});

await test('a concern about the agency’s staff can never be shared with an agent', async () => {
  const { concernInputSchema } = await import('../src/bo/concern.js');
  assert.equal(
    concernInputSchema.safeParse({ ...aboutAgency, shareWithMyAgent: true }).success,
    false,
  );
  assert.equal(concernInputSchema.safeParse({ ...aboutAgency }).success, true);
  assert.equal(concernInputSchema.safeParse({ ...about, shareWithMyAgent: true }).success, true);
});

const recorded = {
  about: 'profile' as const,
  memberCode: 'M1',
  category: 'harassment' as const,
  message: 'He keeps calling her at night after she said no.',
  toldBy: 'phone' as const,
};

await test('an agent records a concern about another member for their own assisted client', async () => {
  const { service, told } = setup();
  const open = await service.recordFor(actor('agent', NASRIN), ASSISTED, recorded, 'c');
  assert.equal(open.length, 1);
  assert.equal(open[0]?.recorded?.toldBy, 'phone');
  assert.notEqual(open[0]?.reporter, null, 'the agent who recorded it sees whose worry it is');
  // The admins and the agent of the profile reported are told; the person who recorded it is not.
  assert.deepEqual(told, [`staff:${SALMA}`]);
  // The agent of the profile reported can read it, without a name.
  const salma = await service.list(actor('agent', SALMA), 'open');
  assert.equal(salma.length, 1);
  assert.equal(salma[0]?.reporter, null);
});

await test('only an admin records a concern about the agency, so it never passes through an agent', async () => {
  const { service } = setup();
  const staffConcern = {
    about: 'agency' as const,
    category: 'staff_conduct' as const,
    message: 'Her agent asks for money outside the agreed fee.',
    toldBy: 'visit' as const,
  };
  await assert.rejects(
    service.recordFor(actor('agent', NASRIN), ASSISTED, staffConcern, 'c'),
    code(403, 'CONCERN_ADMIN_ONLY'),
  );
  const open = await service.recordFor(actor('admin', ADMIN), ASSISTED, staffConcern, 'c');
  assert.equal(open.length, 1);
  // The agent does not see it, not even their own client's.
  assert.deepEqual(await service.list(actor('agent', NASRIN), 'open'), []);
});

await test('a concern can be recorded only for a client with no login, who looks after them, and about another profile', async () => {
  const { service } = setup();
  await assert.rejects(
    service.recordFor(actor('agent', NASRIN), LOGIN_CLIENT, recorded, 'c'),
    code(409, 'CLIENT_HAS_LOGIN'),
  );
  await assert.rejects(
    service.recordFor(actor('agent', KAMAL), ASSISTED, recorded, 'c'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    service.recordFor(actor('agent', NASRIN), ASSISTED, { ...recorded, memberCode: 'NOPE' }, 'c'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  for (const role of ['member', 'guardian'] as const)
    await assert.rejects(
      service.recordFor(actor(role, MEMBER), ASSISTED, recorded, 'c'),
      code(403, 'ROLE_FORBIDDEN'),
    );
});

await test('the outcome of a concern recorded for a client is kept, and nobody gets an inbox line for it', async () => {
  const { service, told } = setup();
  await service.recordFor(actor('agent', NASRIN), ASSISTED, recorded, 'c');
  told.length = 0;
  const [concern] = await service.list(actor('admin', ADMIN), 'open');
  await service.resolve(actor('admin', ADMIN), concern!.id, 'We warned him.', 'c');
  assert.deepEqual(told, [], 'a client with no login has no inbox: staff tell them');
});
