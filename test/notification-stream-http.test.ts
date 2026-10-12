import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import {
  account,
  agency,
  authFor,
  config,
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

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

async function setup(options: { refuse?: boolean; unreadFails?: boolean } = {}) {
  const listeners: (() => void)[] = [];
  const stopped: number[] = [];
  const state = { unread: 2, asked: [] as ProfileActor[] };
  const app = await buildApp({
    config,
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
    live: {
      subscribe: (agencyId: string, accountId: string, listener: () => void) => {
        assert.equal(agencyId, agency);
        assert.equal(accountId, account.id);
        if (options.refuse) return null;
        listeners.push(listener);
        return () => {
          stopped.push(listeners.length);
        };
      },
      unread: async (actor: ProfileActor) => {
        state.asked.push(actor);
        if (options.unreadFails && state.asked.length > 1) throw new Error('down');
        return state.unread;
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
    auth: authFor(async () => ({ ...account, role: 'member' as const })),
    access: unusedAccess,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { app, port, listeners, stopped, state };
}

/** Opens the stream and collects what arrives, until `done` says enough or the stream ends. */
function open(port: number, done: (text: string) => boolean = () => false) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: () => string;
    close: () => void;
    ended: Promise<void>;
    waitFor: (match: (text: string) => boolean) => Promise<void>;
  }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/me/notifications/stream',
        headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token' },
      },
      (res) => {
        let text = '';
        const waiters: { match: (t: string) => boolean; resolve: () => void }[] = [];
        let finished: () => void = () => undefined;
        const ended = new Promise<void>((r) => (finished = r));
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          for (const w of [...waiters]) {
            if (w.match(text)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve();
            }
          }
          void done;
        });
        res.on('end', finished);
        res.on('close', finished);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => text,
          close: () => req.destroy(),
          ended,
          waitFor: (match) =>
            match(text)
              ? Promise.resolve()
              : new Promise<void>((r) => waiters.push({ match, resolve: r })),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const withTimeout = <T>(promise: Promise<T>, ms = 3000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);

await test('the stream sends the unread count at once, and again each time a line is added', async (t) => {
  const { app, port, listeners, state } = await setup();
  t.after(() => app.close());
  const stream = await open(port);
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  assert.match(String(stream.headers['content-type']), /text\/event-stream/);
  assert.match(String(stream.headers['cache-control']), /no-store/);
  assert.equal(stream.headers['x-accel-buffering'], 'no');

  await withTimeout(stream.waitFor((text) => text.includes('"unread":2')));
  assert.match(stream.text(), /^retry: 5000/);
  assert.equal(listeners.length, 1);

  // A line was added: the count is read again and sent.
  state.unread = 5;
  listeners[0]!();
  await withTimeout(stream.waitFor((text) => text.includes('"unread":5')));
  // The account and agency came from the session, never from the request.
  assert.ok(state.asked.every((a) => a.accountId === account.id && a.agencyId === agency));
  // Only the count travels: no names, no inbox text.
  assert.equal(/fullName|memberCode|about/.test(stream.text()), false);
});

await test('closing the stream lets go of the listener', async (t) => {
  const { app, port, stopped } = await setup();
  t.after(() => app.close());
  const stream = await open(port);
  await withTimeout(stream.waitFor((text) => text.includes('unread')));
  stream.close();
  for (let i = 0; i < 40 && stopped.length === 0; i += 1)
    await new Promise((r) => setTimeout(r, 25));
  assert.equal(stopped.length, 1);
});

await test('an account with too many open streams is refused, and nobody signed in is not served', async (t) => {
  const refused = await setup({ refuse: true });
  t.after(() => refused.app.close());
  const res = await open(refused.port);
  assert.equal(res.status, 429);
  res.close();

  const open401 = await setup();
  t.after(() => open401.app.close());
  const anonymous = await open401.app.inject({
    url: '/api/v1/me/notifications/stream',
    headers: { host: 'localhost' },
  });
  assert.equal(anonymous.statusCode, 401);
});

await test('if the count cannot be read any more the stream ends, so the page can decide', async (t) => {
  const { app, port, listeners } = await setup({ unreadFails: true });
  t.after(() => app.close());
  const stream = await open(port);
  await withTimeout(stream.waitFor((text) => text.includes('"unread":2')));
  listeners[0]!();
  await withTimeout(stream.ended);
});
