import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import { loadConfig } from '../src/config/env.js';
import {
  account,
  agency,
  authFor,
  config,
  env,
  unusedAccess,
  unusedCandidates,
  unusedClients,
  unusedConnections,
  unusedCvs,
  unusedInvitations,
  unusedMatches,
  unusedPhotos,
  unusedProfiles,
  unusedReviews,
} from './fixtures.js';

/** A Redis stand-in that counts per key, like the real limiter, and remembers what it was asked. */
function countingRedis() {
  const counts = new Map<string, number>();
  const asked: { key: string; max: number }[] = [];
  const redis = {
    defineCommand: () => {},
    rateLimit: (...args: unknown[]) => {
      const key = String(args[0]);
      const max = Number(args[2]);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      asked.push({ key, max });
      (args.at(-1) as (err: null, value: number[]) => void)(null, [next, 60000]);
    },
  } as unknown as Redis;
  return { redis, asked };
}

async function setup(appConfig = config) {
  const { redis, asked } = countingRedis();
  const app = await buildApp({
    config: appConfig,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    reviews: unusedReviews,
    clients: unusedClients,
    candidates: unusedCandidates,
    matches: unusedMatches,
    connections: unusedConnections,
    invitations: unusedInvitations,
    photos: unusedPhotos,
    cvs: unusedCvs,
    live: { subscribe: () => null, unread: async () => 0 },
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
    auth: authFor(async () => ({ ...account, role: 'member' as const })),
    access: unusedAccess,
  });
  return { app, asked };
}

const signedIn = { host: 'localhost', authorization: 'Bearer valid.jwt.token' };

await test('a signed-in person is counted on their own, not by address, with a roomier allowance', async (t) => {
  const { app, asked } = await setup();
  t.after(() => app.close());
  await app.inject({
    url: '/api/v1/me/profile',
    headers: signedIn,
    remoteAddress: '198.51.100.7',
  });
  const entry = asked.at(-1)!;
  assert.ok(entry.key.includes(`u:${agency}:${account.id}`), entry.key);
  assert.equal(entry.key.includes('198.51.100.7'), false);
  assert.equal(entry.max, 300);
});

await test('two people behind one address do not share a count once signed in', async (t) => {
  const { app, asked } = await setup();
  t.after(() => app.close());
  for (let i = 0; i < 5; i += 1)
    await app.inject({
      url: '/api/v1/me/profile',
      headers: signedIn,
      remoteAddress: '198.51.100.7',
    });
  // Every request is counted under the person; none under the shared address.
  assert.equal(
    asked.some((a) => a.key.includes('198.51.100.7')),
    false,
  );
  assert.equal(asked.length, 5);
});

await test('someone not signed in is still counted by address, with the usual allowance', async (t) => {
  const { app, asked } = await setup();
  t.after(() => app.close());
  await app.inject({
    url: '/api/v1/auth/methods',
    headers: { host: 'localhost' },
    remoteAddress: '198.51.100.7',
  });
  const entry = asked.at(-1)!;
  assert.ok(entry.key.includes('198.51.100.7'), entry.key);
  assert.equal(entry.max, 120);
});

await test('the agency lookup every page makes has a roomier allowance than other public calls', async (t) => {
  const { app, asked } = await setup();
  t.after(() => app.close());
  await app.inject({
    url: '/api/v1/public/tenant',
    headers: { host: 'localhost' },
    remoteAddress: '198.51.100.7',
  });
  assert.equal(asked.at(-1)!.max, 1200);
});

await test('a forwarded address is ignored unless the proxy is named in TRUST_PROXY', async (t) => {
  const forwarded = { host: 'localhost', 'x-forwarded-for': '203.0.113.9' };

  const plain = await setup();
  t.after(() => plain.app.close());
  await plain.app.inject({
    url: '/api/v1/auth/methods',
    headers: forwarded,
    remoteAddress: '127.0.0.1',
  });
  assert.ok(plain.asked.at(-1)!.key.includes('127.0.0.1'));
  assert.equal(plain.asked.at(-1)!.key.includes('203.0.113.9'), false);

  const trusted = await setup(loadConfig({ ...env, TRUST_PROXY: '127.0.0.1' }));
  t.after(() => trusted.app.close());
  await trusted.app.inject({
    url: '/api/v1/auth/methods',
    headers: forwarded,
    remoteAddress: '127.0.0.1',
  });
  assert.ok(trusted.asked.at(-1)!.key.includes('203.0.113.9'));

  // A machine that is not the named proxy cannot claim an address.
  await trusted.app.inject({
    url: '/api/v1/auth/methods',
    headers: forwarded,
    remoteAddress: '198.51.100.7',
  });
  assert.ok(trusted.asked.at(-1)!.key.includes('198.51.100.7'));
  assert.equal(trusted.asked.at(-1)!.key.includes('203.0.113.9'), false);
});

await test('TRUST_PROXY accepts off, a number of proxies, or addresses and ranges, and nothing else', () => {
  const read = (value?: string) =>
    loadConfig(value === undefined ? env : { ...env, TRUST_PROXY: value }).TRUST_PROXY;
  assert.equal(read(), false);
  assert.equal(read('false'), false);
  assert.equal(read('1'), 1);
  assert.deepEqual(read('127.0.0.1, 10.0.0.0/8'), ['127.0.0.1', '10.0.0.0/8']);
  assert.deepEqual(read('::1'), ['::1']);
  // "Trust everyone" would let any visitor claim any address.
  for (const bad of ['true', '0', '10', 'yes', '10.0.0.0/33', '1.2.3', '127.0.0.1/8/8'])
    assert.throws(() => read(bad), /Invalid configuration: TRUST_PROXY/, bad);
});
