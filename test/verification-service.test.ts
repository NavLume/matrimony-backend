import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { WorkflowEvent } from '../src/bo/event.js';
import { rejectInputSchema } from '../src/bo/verification.js';
import type {
  StoredRequest,
  VerificationProfile,
} from '../src/db/raw/repository/verification-repository.js';
import type { VerificationUnit } from '../src/db/service/verification-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { VerificationService } from '../src/service/verification-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = ID(1);
const SALMA = ID(11);
const KAMAL = ID(12);
const MEMBER = ID(21);
const CLIENT = ID(201);

const actor = (role: 'admin' | 'agent' | 'member', accountId: string) => ({
  agencyId: agency,
  accountId,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

// A real (tiny) PNG, so the type check that reads the file's own bytes passes.
const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();

const pic = await png();

function setup(profile: Partial<VerificationProfile> = {}) {
  const state = {
    profile: {
      id: CLIENT,
      memberCode: 'M1',
      fullName: 'Rahim',
      status: 'active',
      assignedAgentId: SALMA,
      ownerAccountId: MEMBER,
      verifiedAt: null,
      verifiedChecks: [],
      ...profile,
    } as VerificationProfile,
    requests: [] as StoredRequest[],
    events: [] as WorkflowEvent[],
    told: [] as string[],
  };
  const files = new Map<string, Buffer>();
  const unit = {
    profileById: async (_a: string, id: string) => (id === CLIENT ? state.profile : null),
    ownProfile: async (_a: string, account: string) =>
      account === state.profile.ownerAccountId ? state.profile : null,
    latest: async () => state.requests.at(-1) ?? null,
    insert: async (
      _a: string,
      r: { id: string; docType: never; key: string; submittedBy: string },
    ) => {
      state.requests.push({
        row: {
          id: r.id,
          docType: r.docType,
          status: 'pending',
          submittedAt: '2026-10-20T10:00:00.000Z',
          decidedAt: null,
          note: null,
          hasFile: true,
        },
        fileKey: r.key,
        profileId: CLIENT,
        submittedBy: r.submittedBy,
        fileRemoved: false,
      });
    },
    mimeOf: async () => 'image/png' as const,
    decide: async (_a: string, id: string, status: never, _by: string, note: string | null) => {
      const found = state.requests.find((r) => r.row.id === id);
      if (!found || found.row.status !== 'pending') return false;
      found.row.status = status;
      found.row.note = note;
      found.row.hasFile = false;
      return true;
    },
    markFileRemoved: async (_a: string, id: string) => {
      const found = state.requests.find((r) => r.row.id === id);
      if (found) found.fileRemoved = true;
    },
    setVerified: async (
      _a: string,
      _id: string,
      by: string | null,
      checks: readonly string[] = [],
    ) => {
      state.profile.verifiedAt = by ? '2026-10-20T10:05:00.000Z' : null;
      state.profile.verifiedChecks = by ? ['identity', ...checks] : [];
    },
    setRequestChecks: async () => {},
    setChecks: async (_a: string, _id: string, checks: readonly string[]) => {
      state.profile.verifiedChecks = ['identity', ...checks];
    },
    tellReviewers: async () => void state.told.push('reviewers'),
    tellDecided: async (_a: string, _p: string, _to: string, _by: string, outcome: string) =>
      void state.told.push(outcome),
    waiting: async () => [],
    appendEvent: async (event: WorkflowEvent) => void state.events.push(event),
  };
  const db = {
    inTransaction: async <T>(_agency: string, work: (u: VerificationUnit) => Promise<T>) =>
      work(unit as unknown as VerificationUnit),
  };
  const storage = {
    put: async (key: string, data: Buffer) => void files.set(key, data),
    get: async (key: string) => files.get(key) ?? null,
    delete: async (key: string) => void files.delete(key),
  };
  let n = 900;
  const service = new VerificationService(
    db,
    storage,
    { error: () => undefined },
    () => new Date('2026-10-20T10:00:00Z'),
    () => ID(n++),
  );
  return { state, files, service };
}

await test('a member sends a document, the file is stored privately and staff are told', async () => {
  const { service, state, files } = setup();
  const result = await service.submit(
    actor('member', MEMBER),
    { kind: 'own' },
    'nid',
    pic,
    'image/png',
    'r',
  );
  assert.equal(result.request?.status, 'pending');
  assert.equal(result.verified, null);
  assert.equal(files.size, 1);
  assert.match([...files.keys()][0]!, new RegExp(`^${agency}/${CLIENT}/verification-.*\\.png$`));
  assert.deepEqual(state.told, ['reviewers']);
  assert.equal(state.events[0]?.type, 'verification.submitted');
});

await test('a file that is not really a PDF, JPEG or PNG, or is too big, is refused and nothing is stored', async () => {
  const { service, files } = setup();
  await assert.rejects(
    () =>
      service.submit(
        actor('member', MEMBER),
        { kind: 'own' },
        'nid',
        Buffer.from('MZ not a picture'),
        'image/png',
        'r',
      ),
    code(422, 'DOCUMENT_INVALID'),
  );
  await assert.rejects(
    () =>
      service.submit(
        actor('member', MEMBER),
        { kind: 'own' },
        'nid',
        Buffer.alloc(6 * 1024 * 1024),
        'image/png',
        'r',
      ),
    code(413, 'PAYLOAD_TOO_LARGE'),
  );
  assert.equal(files.size, 0);
});

await test('only one request waits at a time, and a verified profile cannot send another', async () => {
  const { service } = setup();
  await service.submit(actor('member', MEMBER), { kind: 'own' }, 'nid', pic, 'image/png', 'r');
  await assert.rejects(
    () =>
      service.submit(actor('member', MEMBER), { kind: 'own' }, 'passport', pic, 'image/png', 'r'),
    code(409, 'VERIFICATION_PENDING'),
  );
  const verified = setup({ verifiedAt: '2026-10-01T00:00:00.000Z' });
  await assert.rejects(
    () =>
      verified.service.submit(
        actor('member', MEMBER),
        { kind: 'own' },
        'nid',
        pic,
        'image/png',
        'r',
      ),
    code(409, 'ALREADY_VERIFIED'),
  );
});

await test('approving sets the mark, tells the sender and deletes the document', async () => {
  const { service, state, files } = setup();
  await service.submit(actor('member', MEMBER), { kind: 'own' }, 'nid', pic, 'image/png', 'r');
  const result = await service.approve(actor('agent', SALMA), CLIENT, [], 'r2');
  assert.ok(result.verified);
  assert.equal(files.size, 0);
  assert.equal(state.requests[0]?.fileRemoved, true);
  assert.deepEqual(state.told, ['reviewers', 'approved']);
  assert.deepEqual(
    state.events.map((e) => e.type),
    ['verification.submitted', 'verification.approved'],
  );
});

await test('rejecting keeps the reason, no mark is given, the file is deleted and the person can try again', async () => {
  const { service, state, files } = setup();
  await service.submit(actor('member', MEMBER), { kind: 'own' }, 'nid', pic, 'image/png', 'r');
  const result = await service.reject(actor('agent', SALMA), CLIENT, 'The photo is blurred', 'r2');
  assert.equal(result.verified, null);
  assert.equal(result.request?.status, 'rejected');
  assert.equal(result.request?.note, 'The photo is blurred');
  assert.equal(files.size, 0);
  const again = await service.submit(
    actor('member', MEMBER),
    { kind: 'own' },
    'nid',
    pic,
    'image/png',
    'r3',
  );
  assert.equal(again.request?.status, 'pending');
  assert.equal(state.requests.length, 2);
  assert.equal(rejectInputSchema.safeParse({ note: 'x' }).success, false);
});

await test('an agent decides only for clients they look after, and never their own submission; an admin may', async () => {
  const other = setup({ assignedAgentId: KAMAL });
  await other.service.submit(
    actor('member', MEMBER),
    { kind: 'own' },
    'nid',
    pic,
    'image/png',
    'r',
  );
  await assert.rejects(
    () => other.service.approve(actor('agent', SALMA), CLIENT, [], 'r'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    () => other.service.approve(actor('member', MEMBER), CLIENT, [], 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );

  // The agent sends it for an assisted client, so the agent cannot decide it.
  const own = setup({ ownerAccountId: null });
  await own.service.submit(
    actor('agent', SALMA),
    { kind: 'client', profileId: CLIENT },
    'nid',
    pic,
    'image/png',
    'r',
  );
  await assert.rejects(
    () => own.service.approve(actor('agent', SALMA), CLIENT, [], 'r'),
    code(409, 'REVIEW_OWN_SUBMISSION'),
  );
  const byAdmin = await own.service.approve(actor('admin', ADMIN), CLIENT, [], 'r');
  assert.ok(byAdmin.verified);
});

await test('the sender can take a waiting request back and the file is deleted', async () => {
  const { service, files } = setup();
  await service.submit(actor('member', MEMBER), { kind: 'own' }, 'nid', pic, 'image/png', 'r');
  const result = await service.withdraw(actor('member', MEMBER), { kind: 'own' }, 'r2');
  assert.equal(result.request?.status, 'withdrawn');
  assert.equal(files.size, 0);
  await assert.rejects(
    () => service.withdraw(actor('member', MEMBER), { kind: 'own' }, 'r3'),
    code(404, 'VERIFICATION_NOT_FOUND'),
  );
});

await test('opening the document is recorded, only while it waits, and only for staff who look after the client', async () => {
  const { service, state } = setup();
  await service.submit(actor('member', MEMBER), { kind: 'own' }, 'nid', pic, 'image/png', 'r');
  const file = await service.file(actor('agent', SALMA), CLIENT, 'r2');
  assert.equal(file.mime, 'image/png');
  assert.equal(state.events.at(-1)?.type, 'verification.file_viewed');
  await assert.rejects(
    () => service.file(actor('agent', KAMAL), CLIENT, 'r'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await service.approve(actor('agent', SALMA), CLIENT, [], 'r3');
  await assert.rejects(
    () => service.file(actor('agent', SALMA), CLIENT, 'r4'),
    code(404, 'VERIFICATION_NOT_FOUND'),
  );
});

await test('only an admin takes the mark away, and only when there is one', async () => {
  const { service } = setup({ verifiedAt: '2026-10-01T00:00:00.000Z' });
  await assert.rejects(
    () => service.revoke(actor('agent', SALMA), CLIENT, 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  const result = await service.revoke(actor('admin', ADMIN), CLIENT, 'r');
  assert.equal(result.verified, null);
  await assert.rejects(
    () => service.revoke(actor('admin', ADMIN), CLIENT, 'r'),
    code(409, 'NOT_VERIFIED'),
  );
});

await test('members cannot see the waiting list', async () => {
  const { service } = setup();
  await assert.rejects(() => service.waiting(actor('member', MEMBER)), code(403, 'ROLE_FORBIDDEN'));
  assert.deepEqual(await service.waiting(actor('agent', SALMA)), []);
});

await test('an approval records the checks that were made, and identity is always one of them', async () => {
  const { service, state } = setup();
  await service.submit(actor('member', MEMBER), { kind: 'own' }, 'nid', pic, 'image/png', 'r1');
  const approved = await service.approve(
    actor('agent', SALMA),
    CLIENT,
    ['photo', 'photo', 'marital_status'],
    'r2',
  );
  assert.deepEqual(approved.verified?.checks, ['identity', 'photo', 'marital_status']);
  assert.deepEqual(state.profile.verifiedChecks, ['identity', 'photo', 'marital_status']);
});

await test('an approval with no extra checks says only identity was checked', async () => {
  const { service } = setup();
  await service.submit(actor('member', MEMBER), { kind: 'own' }, 'nid', pic, 'image/png', 'r1');
  const approved = await service.approve(actor('agent', SALMA), CLIENT, [], 'r2');
  assert.deepEqual(approved.verified?.checks, ['identity']);
});

await test('staff can add a check to a verified profile later, and cannot on one that is not verified', async () => {
  const verified = setup({ verifiedAt: '2026-10-01T00:00:00.000Z', verifiedChecks: ['identity'] });
  const state = await verified.service.updateChecks(
    actor('agent', SALMA),
    CLIENT,
    ['marital_status'],
    'r',
  );
  assert.deepEqual(state.verified?.checks, ['identity', 'marital_status']);
  assert.deepEqual(verified.state.events.at(-1)?.type, 'verification.checks_changed');

  const plain = setup();
  await assert.rejects(
    () => plain.service.updateChecks(actor('agent', SALMA), CLIENT, ['photo'], 'r'),
    code(409, 'NOT_VERIFIED'),
  );
  await assert.rejects(
    () => verified.service.updateChecks(actor('member', MEMBER), CLIENT, ['photo'], 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
});
