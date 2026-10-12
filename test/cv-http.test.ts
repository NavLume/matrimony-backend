import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import { safeFileName, type CvState } from '../src/bo/cv.js';
import { assertPdf } from '../src/security/pdf-check.js';
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
  unusedInvitations,
  unusedLive,
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

const ID = '33333333-3333-4333-8333-333333333333';
const empty: CvState = { current: null, replacement: null };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n');

async function setup(role: 'member' | 'agent' | 'admin' = 'member') {
  const calls: { name: string; actor: ProfileActor; args: unknown[] }[] = [];
  const record =
    <T>(name: string, result: T) =>
    async (actor: ProfileActor, ...args: unknown[]) => {
      calls.push({ name, actor, args });
      return result;
    };
  const file = { bytes: PDF, fileName: 'zara cv.pdf' };
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
    live: unusedLive,
    cvs: {
      state: record('state', empty),
      upload: record('upload', empty),
      remove: record('remove', empty),
      review: record('review', empty),
      file: record('file', file),
      fileOfConnection: record('fileOfConnection', file),
      infoOfConnection: record('infoOfConnection', null),
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
  const call = (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    options: { payload?: Buffer | object; type?: string; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      payload: options.payload as Buffer | undefined,
      headers: {
        host: 'localhost',
        authorization: 'Bearer valid.jwt.token',
        ...(options.type ? { 'content-type': options.type } : {}),
        ...options.headers,
      },
    });
  return { app, call, calls };
}

await test('members use their own CV routes, staff the client routes, and neither the other', async (t) => {
  for (const role of ['member', 'agent', 'admin'] as const) {
    const { app, call } = await setup(role);
    t.after(() => app.close());
    const own = role === 'member';
    const ownRoutes: [string, string][] = [
      ['GET', '/api/v1/me/profile/cv'],
      ['DELETE', '/api/v1/me/profile/cv'],
      ['GET', '/api/v1/me/profile/cv/file'],
      ['GET', `/api/v1/me/matches/${ID}/cv`],
      ['GET', `/api/v1/me/matches/${ID}/cv/file`],
    ];
    const staffRoutes: [string, string][] = [
      ['GET', `/api/v1/staff/clients/${ID}/cv`],
      ['DELETE', `/api/v1/staff/clients/${ID}/cv`],
      ['GET', `/api/v1/staff/clients/${ID}/cv/file`],
    ];
    for (const [method, url] of ownRoutes) {
      const res = await call(method as 'GET', url);
      assert.equal(res.statusCode, own ? 200 : 403, `${role} ${method} ${url}`);
    }
    for (const [method, url] of staffRoutes) {
      const res = await call(method as 'GET', url);
      assert.equal(res.statusCode, own ? 403 : 200, `${role} ${method} ${url}`);
    }
  }
  const { app } = await setup();
  t.after(() => app.close());
  const anonymous = await app.inject({
    url: '/api/v1/me/profile/cv',
    headers: { host: 'localhost' },
  });
  assert.equal(anonymous.statusCode, 401);
});

await test('a PDF is the request body, the name comes from a header, and only PDF is accepted', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const res = await call('PUT', '/api/v1/me/profile/cv', {
    payload: PDF,
    type: 'application/pdf',
    headers: { 'x-file-name': 'My%20CV.pdf' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), empty);
  const upload = calls.find((c) => c.name === 'upload')!;
  assert.equal(upload.actor.accountId, account.id);
  assert.deepEqual(upload.args[0], { kind: 'own' });
  assert.deepEqual(upload.args[1], PDF);
  assert.equal(upload.args[2], 'My%20CV.pdf');
  for (const type of ['image/png', 'application/json', 'text/plain']) {
    const bad = await call('PUT', '/api/v1/me/profile/cv', { payload: Buffer.from('x'), type });
    assert.ok(bad.statusCode === 415 || bad.statusCode === 400, `${type}: ${bad.statusCode}`);
  }
  // Too big for the body limit.
  const huge = await call('PUT', '/api/v1/me/profile/cv', {
    payload: Buffer.alloc(5 * 1024 * 1024 + 10, 0x41),
    type: 'application/pdf',
  });
  assert.equal(huge.statusCode, 413);
});

await test('the file goes out with headers that stop a browser running or guessing at it', async (t) => {
  const { app, call } = await setup();
  t.after(() => app.close());
  const res = await call('GET', '/api/v1/me/profile/cv/file?which=replacement');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(String(res.headers['content-security-policy']), /sandbox/);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.match(String(res.headers['content-disposition']), /filename\*=UTF-8''zara%20cv\.pdf/);
  assert.deepEqual(res.rawPayload, PDF);
  const badQuery = await call('GET', '/api/v1/me/profile/cv/file?which=other');
  assert.equal(badQuery.statusCode, 400);
});

await test('staff review takes only approve or reject, with an optional short note', async (t) => {
  const { app, call, calls } = await setup('agent');
  t.after(() => app.close());
  const url = `/api/v1/staff/clients/${ID}/cv/review`;
  for (const body of [
    {},
    { decision: 'maybe' },
    { decision: 'approve', extra: 1 },
    { decision: 'reject', notes: 'x'.repeat(501) },
  ]) {
    assert.equal((await call('POST', url, { payload: body })).statusCode, 400);
  }
  const ok = await call('POST', url, { payload: { decision: 'reject', notes: ' Too blurry. ' } });
  assert.equal(ok.statusCode, 200);
  const review = calls.find((c) => c.name === 'review')!;
  assert.deepEqual(review.args.slice(0, 3), [ID, false, 'Too blurry.']);
});

await test('the PDF check refuses what is not a PDF and what carries active content', () => {
  assert.doesNotThrow(() => assertPdf(PDF));
  for (const bad of [
    Buffer.from('hello'),
    Buffer.from('%PDF-1.4\nno end marker here at all, only text'),
    Buffer.from('%PDF-1.7\n<< /JS (x) >>\n%%EOF'),
    Buffer.from('%PDF-1.7\n<< /OpenAction 1 0 R >>\n%%EOF'),
    Buffer.from('%PDF-1.7\n<< /Launch << >> >>\n%%EOF'),
    Buffer.from('%PDF-1.7\n<< /Jav#61Script (x) >>\n%%EOF'),
    Buffer.from('%PDF-1.7\n<< /EmbeddedFile 1 0 R >>\n%%EOF'),
  ]) {
    assert.throws(() => assertPdf(bad), /CV_/);
  }
  // Ordinary words are not active content.
  assert.doesNotThrow(() =>
    assertPdf(Buffer.from('%PDF-1.4\n(Java and JavaScript skills)\n%%EOF\n')),
  );
});

await test('a file name is cut down to something safe to show and to send back', () => {
  assert.equal(safeFileName(undefined), 'cv.pdf');
  assert.equal(safeFileName(''), 'cv.pdf');
  assert.equal(safeFileName('My%20CV.pdf'), 'My CV.pdf');
  assert.equal(safeFileName('C:\\Users\\me\\resume.PDF'), 'resume.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd.pdf');
  assert.equal(safeFileName('a"b<c>.pdf'), 'abc.pdf');
  assert.equal(safeFileName('x'.repeat(500)).length, 120);
  assert.equal(safeFileName('%E0%A4%A'), '%E0%A4%A.pdf');
});
