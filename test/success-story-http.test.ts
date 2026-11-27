import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { AdminStory } from '../src/bo/success-story.js';
import { buildApp } from '../src/controller/app.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import {
  account,
  agency,
  authFor,
  config,
  unusedAccess,
  unusedCandidates,
  unusedConnections,
  unusedClients,
  unusedInvitations,
  unusedPhotos,
  unusedCvs,
  unusedLive,
  unusedMatches,
  unusedProfiles,
  unusedReviews,
} from './fixtures.js';

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

const STORY = '55555555-5555-4555-8555-555555555555';
const story: AdminStory = {
  id: STORY,
  source: 'manual',
  names: { en: 'Rahim and Karima' },
  story: null,
  year: 2014,
  weddingDate: null,
  status: 'draft',
  canPublish: false,
  consentNote: null,
  consentRecordedAt: null,
  hasPhoto: false,
  removed: false,
  createdAt: '2026-11-27T10:00:00.000Z',
  publishedAt: null,
};

async function setup(role: 'admin' | 'agent' | 'member' = 'admin') {
  const calls: { name: string; actor: ProfileActor; args: unknown[] }[] = [];
  const unused = async () => {
    throw new Error('not used here');
  };
  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    photos: unusedPhotos,
    cvs: unusedCvs,
    live: unusedLive,
    reviews: unusedReviews,
    clients: unusedClients,
    candidates: unusedCandidates,
    connections: unusedConnections,
    invitations: unusedInvitations,
    matches: unusedMatches,
    coupleMatches: {
      markMatched: unused,
      undoMatch: unused,
      setStoryStatus: unused,
      removeStory: unused,
      listStories: async (actor) => {
        calls.push({ name: 'list', actor, args: [] });
        return { stories: [story] };
      },
      createManualStory: async (actor, ...args) => {
        calls.push({ name: 'create', actor, args });
        return story;
      },
      updateManualStory: async (actor, ...args) => {
        calls.push({ name: 'update', actor, args });
        return story;
      },
    },
    registrations: { signInMethods: async () => null },
    identities: {
      tenant: async () => ({
        id: agency,
        hostname: 'localhost',
        name: 'MSBD',
        locale: 'bn',
        publicConfig: { branches: [], successStories: [] },
      }),
    },
    auth: authFor(async () => ({ ...account, role })),
    access: unusedAccess,
  });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token' },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { app, call, calls };
}

const NEW = { names: { en: 'Rahim and Karima' } };

await test('only an admin lists, adds or edits success stories; an agent and a member are refused', async (t) => {
  for (const role of ['agent', 'member'] as const) {
    const { app, call, calls } = await setup(role);
    t.after(() => app.close());
    assert.equal((await call('GET', '/api/v1/admin/success-stories')).statusCode, 403, role);
    assert.equal((await call('POST', '/api/v1/admin/success-stories', NEW)).statusCode, 403, role);
    assert.equal(
      (await call('PUT', `/api/v1/admin/success-stories/${STORY}`, NEW)).statusCode,
      403,
      role,
    );
    assert.equal(calls.length, 0);
  }
  const { app, call } = await setup('admin');
  t.after(() => app.close());
  const anonymous = await app.inject({
    url: '/api/v1/admin/success-stories',
    headers: { host: 'localhost' },
  });
  assert.equal(anonymous.statusCode, 401);
  const list = await call('GET', '/api/v1/admin/success-stories');
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { stories: [story] });
});

await test('a new story is cleaned and defaulted; the permission note and the names are checked', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const created = await call('POST', '/api/v1/admin/success-stories', {
    names: { bn: '  রহিম ও করিমা ', en: '' },
    text: { en: 'Met in 2013.' },
    weddingDate: '2014-02-14',
    consent: { note: ' written permission from both, 20 Nov 2026 ' },
    publish: true,
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(calls[0]?.args[0], {
    names: { bn: 'রহিম ও করিমা' },
    text: { en: 'Met in 2013.' },
    year: null,
    weddingDate: '2014-02-14',
    consent: { note: 'written permission from both, 20 Nov 2026' },
    publish: true,
  });
  assert.equal((await call('POST', '/api/v1/admin/success-stories', NEW)).statusCode, 201);
  assert.deepEqual(calls[1]?.args[0], {
    names: { en: 'Rahim and Karima' },
    text: {},
    year: null,
    weddingDate: null,
    consent: null,
    publish: false,
  });
  for (const bad of [
    {},
    { names: {} },
    { names: { bn: ' ', en: '' } },
    { ...NEW, consent: { note: 'ok' } },
    { ...NEW, consent: { note: 'x'.repeat(301) } },
    { ...NEW, weddingDate: '2014-02-30' },
    { ...NEW, year: 1800 },
    { ...NEW, source: 'match' },
    { ...NEW, matchId: STORY },
    { ...NEW, names: { en: 'x'.repeat(121) } },
  ]) {
    assert.equal(
      (await call('POST', '/api/v1/admin/success-stories', bad)).statusCode,
      400,
      JSON.stringify(bad),
    );
  }
  assert.equal(calls.length, 2);
});

await test('an edit takes the whole story without a publish flag, and the story id must be an id', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const res = await call('PUT', `/api/v1/admin/success-stories/${STORY}`, {
    ...NEW,
    year: 2014,
    consent: null,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0]?.args[0], STORY);
  assert.equal(
    (await call('PUT', `/api/v1/admin/success-stories/${STORY}`, { ...NEW, publish: true }))
      .statusCode,
    400,
  );
  assert.equal((await call('PUT', '/api/v1/admin/success-stories/not-an-id', NEW)).statusCode, 400);
});
