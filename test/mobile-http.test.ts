import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import { MobileService, compareVersions } from '../src/service/mobile-service.js';
import { loadConfig } from '../src/config/env.js';
import {
  config,
  agency,
  authFor,
  unusedAccess,
  unusedPhotos,
  unusedCvs,
  unusedLive,
  unusedReviews,
  unusedClients,
  unusedCandidates,
  unusedMatches,
  unusedConnections,
  unusedInvitations,
  unusedProfiles,
} from './fixtures.js';

const tenant = {
  id: agency,
  hostname: 'noor.example.com',
  name: 'Noor Matrimony',
  locale: 'bn',
  appCode: 'NOOR24',
  publicConfig: { branches: [], successStories: [] },
};
const rules = loadConfig({
  ...process.env,
  ...Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])),
  TENANT_HOSTS: JSON.stringify({ localhost: agency }),
  APP_MIN_VERSION_IOS: '1.2.0',
  APP_LATEST_VERSION_IOS: '1.4.0',
  APP_STORE_URL_IOS: 'https://apps.apple.com/app/id1',
  APP_MIN_VERSION_ANDROID: '1.0.0',
});

await test('versions are compared as numbers, not as text', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.2.0', '1.2.0') === 0);
  assert.ok(compareVersions('0.9.9', '1.0.0') < 0);
});

await test('an app older than the minimum is told to update, and where', () => {
  const service = new MobileService({ byCode: async () => tenant }, rules);
  assert.deepEqual(service.versionStatus('ios', '1.1.9'), {
    supported: false,
    updateAvailable: true,
    minimumVersion: '1.2.0',
    latestVersion: '1.4.0',
    storeUrl: 'https://apps.apple.com/app/id1',
  });
  assert.equal(service.versionStatus('ios', '1.2.0').supported, true);
  assert.equal(service.versionStatus('ios', '1.4.0').updateAvailable, false);
  // Android has no latest or store address set, and its own minimum.
  assert.deepEqual(service.versionStatus('android', '1.0.0'), {
    supported: true,
    updateAvailable: false,
    minimumVersion: '1.0.0',
    latestVersion: null,
    storeUrl: null,
  });
});

await test('the app routes answer without a session or an agency address', async (t) => {
  const redis = {
    defineCommand: () => {},
    rateLimit: (...args: unknown[]) => {
      const callback = args.at(-1) as (err: null, value: number[]) => void;
      callback(null, [1, 60000]);
    },
  } as unknown as Redis;
  const asked: string[] = [];
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
    matches: unusedMatches,
    connections: unusedConnections,
    invitations: unusedInvitations,
    registrations: { signInMethods: async () => null },
    identities: {
      tenant: async () => {
        throw new AppError(404, 'TENANT_NOT_FOUND');
      },
    },
    mobile: new MobileService(
      {
        byCode: async (code) => {
          asked.push(code);
          if (code !== 'NOOR24') throw new AppError(404, 'AGENCY_CODE_NOT_FOUND');
          return tenant;
        },
      },
      rules,
    ),
    auth: authFor(async () => {
      throw new AppError(401, 'INVALID_ACCESS_TOKEN');
    }),
    access: unusedAccess,
  });
  t.after(() => app.close());
  // No Host that names an agency: the tenant lookup above refuses everything.
  const get = (url: string) => app.inject({ url, headers: { host: 'api.example.com' } });

  const found = await get('/api/v1/public/agency-by-code?code=%20noor24');
  assert.equal(found.statusCode, 200);
  const body = found.json();
  assert.equal(body.code, 'NOOR24');
  assert.equal(body.hostname, 'noor.example.com');
  assert.equal(body.name, 'Noor Matrimony');
  assert.equal(body.id, undefined, 'the internal agency id is not given out');
  assert.deepEqual(asked, ['NOOR24']);

  const unknown = await get('/api/v1/public/agency-by-code?code=NOPE99');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, 'AGENCY_CODE_NOT_FOUND');
  assert.equal((await get('/api/v1/public/agency-by-code?code=no')).statusCode, 400);
  assert.equal((await get('/api/v1/public/agency-by-code')).statusCode, 400);

  const version = await get('/api/v1/public/app-version?platform=ios&version=1.1.0');
  assert.equal(version.statusCode, 200);
  assert.equal(version.json().supported, false);
  assert.equal(
    (await get('/api/v1/public/app-version?platform=ios&version=latest')).statusCode,
    400,
  );
  assert.equal(
    (await get('/api/v1/public/app-version?platform=web&version=1.0.0')).statusCode,
    400,
  );
});
