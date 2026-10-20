import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowEvent } from '../src/bo/event.js';
import { markMatchedSchema, undoMatchSchema } from '../src/bo/couple-match.js';
import type { MatchProfile } from '../src/db/raw/repository/couple-match-repository.js';
import type { CoupleMatchUnit } from '../src/db/service/couple-match-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { CoupleMatchService } from '../src/service/couple-match-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SALMA = ID(11);
const KAMAL = ID(12);
const ADMIN = ID(1);
const CONNECTION = ID(100);
const A = ID(201);
const B = ID(202);

const actor = (role: 'admin' | 'agent', accountId: string) => ({
  agencyId: agency,
  accountId,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

function setup(
  options: {
    interest?: string;
    profileA?: Partial<MatchProfile>;
    profileB?: Partial<MatchProfile>;
  } = {},
) {
  const calls: string[] = [];
  const events: WorkflowEvent[] = [];
  const stories: unknown[] = [];
  const fees: Array<[string, number]> = [];
  const profile = (id: string, extra: Partial<MatchProfile>): MatchProfile => ({
    id,
    fullName: id === A ? 'Rahim' : 'Nusrat',
    memberCode: id === A ? 'M1' : 'M2',
    status: 'active',
    assignedAgentId: SALMA,
    ...extra,
  });
  const profiles: Record<string, MatchProfile> = {
    [A]: profile(A, options.profileA ?? {}),
    [B]: profile(B, options.profileB ?? {}),
  };
  let matched = false;
  const unit = {
    interest: async () => ({
      id: CONNECTION,
      status: options.interest ?? 'accepted',
      aId: A,
      bId: B,
    }),
    profile: async (_a: string, id: string) => profiles[id] ?? null,
    existing: async () => matched,
    matchProfile: async (_a: string, id: string) => void calls.push(`match:${id}`),
    setSuccessFee: async (_a: string, id: string, amount: number) => void fees.push([id, amount]),
    insertMatch: async () => {
      matched = true;
      calls.push('insertMatch');
      return ID(300);
    },
    insertStory: async (_a: string, story: unknown) => void stories.push(story),
    standingMatch: async () => (matched ? ID(300) : null),
    undoMatch: async (_a: string, matchId: string, by: string, reason: string) => {
      matched = false;
      calls.push(`undo:${matchId}:${by}:${reason}`);
    },
    reopenProfile: async (_a: string, id: string) => void calls.push(`reopen:${id}`),
    hideStoryOfMatch: async (_a: string, matchId: string) => void calls.push(`hide:${matchId}`),
    setStoryStatus: async (_a: string, id: string) =>
      id === ID(400) ? { changed: true } : id === ID(401) ? { changed: false } : null,
    appendEvent: async (event: WorkflowEvent) => void events.push(event),
  };
  const db = {
    inTransaction: async <T>(_agency: string, work: (u: CoupleMatchUnit) => Promise<T>) =>
      work(unit as unknown as CoupleMatchUnit),
  };
  return {
    calls,
    events,
    stories,
    fees,
    service: new CoupleMatchService(
      db,
      () => new Date('2026-10-20T10:00:00Z'),
      (() => {
        let n = 500;
        return () => ID(n++);
      })(),
    ),
  };
}

const input = (body: object = {}) => markMatchedSchema.parse(body);

await test('an admin can mark any accepted connection as matched: both clients, the record and the event', async () => {
  const { service, calls, events } = setup({
    profileA: { assignedAgentId: SALMA },
    profileB: { assignedAgentId: KAMAL },
  });
  const result = await service.markMatched(
    actor('admin', ADMIN),
    CONNECTION,
    input({ note: 'Families met' }),
    'r1',
  );
  assert.equal(result.matchedAt, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(calls, [`match:${A}`, `match:${B}`, 'insertMatch']);
  assert.equal(events[0]?.type, 'match.recorded');
  assert.equal(events[0]?.subjectId, ID(300));
});

await test('an agent may mark it only when they look after both clients', async () => {
  const both = setup();
  await both.service.markMatched(actor('agent', SALMA), CONNECTION, input(), 'r');
  assert.equal(both.events.length, 1);

  const oneSide = setup({ profileB: { assignedAgentId: KAMAL } });
  await assert.rejects(
    () => oneSide.service.markMatched(actor('agent', SALMA), CONNECTION, input(), 'r'),
    code(403, 'MATCH_NEEDS_ADMIN'),
  );
  assert.deepEqual(oneSide.calls, []);

  const neither = setup({
    profileA: { assignedAgentId: KAMAL },
    profileB: { assignedAgentId: KAMAL },
  });
  await assert.rejects(
    () => neither.service.markMatched(actor('agent', SALMA), CONNECTION, input(), 'r'),
    code(404, 'CONNECTION_NOT_FOUND'),
  );
});

await test('only an accepted connection with two active clients can be matched, and only once', async () => {
  const pending = setup({ interest: 'pending' });
  await assert.rejects(
    () => pending.service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r'),
    code(409, 'CONNECTION_NOT_ACCEPTED'),
  );
  const paused = setup({ profileA: { status: 'paused' } });
  await assert.rejects(
    () => paused.service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r'),
    code(409, 'PROFILE_NOT_ACTIVE'),
  );
  const already = setup({ profileB: { status: 'matched' } });
  await assert.rejects(
    () => already.service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r'),
    code(409, 'ALREADY_MATCHED'),
  );
  const twice = setup();
  await twice.service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r');
  await assert.rejects(
    () => twice.service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r'),
    code(409, 'ALREADY_MATCHED'),
  );
});

await test('success fees are set for the two clients only, and a story records who agreed', async () => {
  const { service, fees, stories } = setup();
  await service.markMatched(
    actor('admin', ADMIN),
    CONNECTION,
    input({
      fees: [
        { profileId: A, amount: 15000 },
        { profileId: B, amount: 5000 },
      ],
      story: { names: { en: 'Rahim & Nusrat' }, text: { en: 'Met here' }, consentFrom: [A] },
    }),
    'r',
  );
  assert.deepEqual(fees, [
    [A, 15000],
    [B, 5000],
  ]);
  const story = stories[0] as { consentA: boolean; consentB: boolean; year: number };
  assert.equal(story.consentA, true);
  assert.equal(story.consentB, false);
  assert.equal(story.year, 2026);

  const stranger = setup();
  await assert.rejects(
    () =>
      stranger.service.markMatched(
        actor('admin', ADMIN),
        CONNECTION,
        input({ fees: [{ profileId: ID(999), amount: 1 }] }),
        'r',
      ),
    code(400, 'INVALID_REQUEST'),
  );
  assert.deepEqual(stranger.calls, []);
});

await test('a story with no names is not created', async () => {
  const { service, stories } = setup();
  await service.markMatched(
    actor('admin', ADMIN),
    CONNECTION,
    input({ story: { names: {}, text: { en: 'x' } } }),
    'r',
  );
  assert.equal(stories.length, 0);
});

await test('only an admin publishes or hides a story, and it needs both clients to have agreed', async () => {
  const { service, events } = setup();
  await assert.rejects(
    () => service.setStoryStatus(actor('agent', SALMA), ID(400), 'published', 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    () => service.setStoryStatus(actor('admin', ADMIN), ID(999), 'published', 'r'),
    code(404, 'STORY_NOT_FOUND'),
  );
  await assert.rejects(
    () => service.setStoryStatus(actor('admin', ADMIN), ID(401), 'published', 'r'),
    code(409, 'CONSENT_MISSING'),
  );
  await service.setStoryStatus(actor('admin', ADMIN), ID(400), 'published', 'r');
  await service.setStoryStatus(actor('admin', ADMIN), ID(400), 'hidden', 'r');
  assert.deepEqual(
    events.map((e) => e.type),
    ['story.published', 'story.hidden'],
  );
});

await test('the request is checked: fees are whole taka within range, notes are trimmed, at most two fees', () => {
  assert.equal(
    markMatchedSchema.safeParse({ fees: [{ profileId: A, amount: -1 }] }).success,
    false,
  );
  assert.equal(
    markMatchedSchema.safeParse({ fees: [{ profileId: A, amount: 1.5 }] }).success,
    false,
  );
  assert.equal(
    markMatchedSchema.safeParse({ fees: [{ profileId: 'x', amount: 1 }] }).success,
    false,
  );
  assert.equal(markMatchedSchema.safeParse({ unknown: true }).success, false);
  assert.equal(markMatchedSchema.parse({ note: '  hello  ' }).note, 'hello');
  assert.equal(markMatchedSchema.parse({ note: '   ' }).note, undefined);
});

await test('a match can be undone with a reason: both clients reopen, the story is hidden, the record stays', async () => {
  const { service, calls, events } = setup();
  await service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r');
  calls.length = 0;
  await service.undoMatch(
    actor('admin', ADMIN),
    CONNECTION,
    undoMatchSchema.parse({ reason: 'Families changed their minds' }),
    'r2',
  );
  assert.deepEqual(calls, [
    `undo:${ID(300)}:${ADMIN}:Families changed their minds`,
    `reopen:${A}`,
    `reopen:${B}`,
    `hide:${ID(300)}`,
  ]);
  assert.equal(events.at(-1)?.type, 'match.undone');
  // They can be matched again afterwards.
  await service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r3');
  assert.equal(events.at(-1)?.type, 'match.recorded');
});

await test('undoing follows the rules of marking: only an admin, or the agent of both clients; and only a standing match', async () => {
  const both = setup();
  await both.service.markMatched(actor('agent', SALMA), CONNECTION, input(), 'r');
  await both.service.undoMatch(
    actor('agent', SALMA),
    CONNECTION,
    undoMatchSchema.parse({ reason: 'A mistake' }),
    'r',
  );

  const split = setup({ profileB: { assignedAgentId: KAMAL } });
  await split.service.markMatched(actor('admin', ADMIN), CONNECTION, input(), 'r');
  await assert.rejects(
    () =>
      split.service.undoMatch(
        actor('agent', SALMA),
        CONNECTION,
        undoMatchSchema.parse({ reason: 'A mistake' }),
        'r',
      ),
    code(403, 'MATCH_NEEDS_ADMIN'),
  );
  const none = setup();
  await assert.rejects(
    () =>
      none.service.undoMatch(
        actor('admin', ADMIN),
        CONNECTION,
        undoMatchSchema.parse({ reason: 'A mistake' }),
        'r',
      ),
    code(409, 'NOT_MATCHED'),
  );
  await assert.rejects(
    () =>
      none.service.undoMatch(
        { ...actor('admin', ADMIN), role: 'member' as never },
        CONNECTION,
        undoMatchSchema.parse({ reason: 'A mistake' }),
        'r',
      ),
    code(403, 'ROLE_FORBIDDEN'),
  );
  assert.equal(undoMatchSchema.safeParse({ reason: 'x' }).success, false);
  assert.equal(undoMatchSchema.safeParse({}).success, false);
});
