import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { acceptAgreementsSchema } from '../src/bo/agreements.js';
import { buildApp } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import { AgreementService } from '../src/service/agreement-service.js';
import {
  config,
  account,
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

const member = { agencyId: agency, accountId: account.id, role: 'member' as const };

function setup(
  current = { terms: 'agency-v1', privacy: 'draft-2026-10' },
  accepted: { terms: string | null; privacy: string | null } = {
    terms: 'draft-2026-10',
    privacy: 'draft-2026-10',
  },
) {
  const state = {
    current,
    accepted: { ...accepted },
    recorded: [] as string[],
    events: [] as string[],
    reads: 0,
  };
  const service = new AgreementService(
    {
      accepted: async () => {
        state.reads += 1;
        return { ...state.accepted };
      },
      accept: async (_a, _acc, versions, event) => {
        for (const v of versions) {
          state.accepted[v.purpose] = v.version;
          state.recorded.push(`${v.purpose}:${v.version}`);
        }
        state.events.push(event.type);
      },
    },
    async () => state.current,
    () => new Date('2026-10-20T10:00:00Z'),
  );
  return { state, service };
}

await test('a member who agreed to an earlier version must agree to the current one; staff never must', async () => {
  const { service } = setup();
  const status = await service.status(member);
  assert.equal(status.required, true);
  assert.deepEqual(status.terms, { current: 'agency-v1', accepted: 'draft-2026-10' });
  assert.equal((await service.status({ ...member, role: 'guardian' })).required, true);
  assert.equal((await service.status({ ...member, role: 'agent' })).required, false);
  assert.equal(await service.mustAgree({ ...member, role: 'admin' }), false);
});

await test('nobody must agree again while the versions match, and a person with no agreement on record must', async () => {
  const same = setup({ terms: 'draft-2026-10', privacy: 'draft-2026-10' });
  assert.equal((await same.service.status(member)).required, false);
  const none = setup(undefined, { terms: null, privacy: null });
  assert.equal((await none.service.status(member)).required, true);
});

await test('agreeing records only the versions that changed, an event, and ends the requirement at once', async () => {
  const { service, state } = setup();
  assert.equal(await service.mustAgree(member), true);
  const after = await service.accept(member, 'r');
  assert.equal(after.required, false);
  assert.deepEqual(state.recorded, ['terms:agency-v1']);
  assert.deepEqual(state.events, ['agreements.accepted']);
  // The earlier "must agree" answer is not kept after agreeing.
  assert.equal(await service.mustAgree(member), false);
  // Agreeing again changes nothing.
  await service.accept(member, 'r2');
  assert.deepEqual(state.recorded, ['terms:agency-v1']);
});

await test('the answer is trusted for a few seconds so a request does not always ask the database', async () => {
  const { service, state } = setup({ terms: 'draft-2026-10', privacy: 'draft-2026-10' });
  await service.mustAgree(member);
  await service.mustAgree(member);
  assert.equal(state.reads, 1);
});

await test('agreeing needs both boxes ticked', () => {
  assert.equal(
    acceptAgreementsSchema.safeParse({ acceptTerms: true, acceptPrivacy: true }).success,
    true,
  );
  assert.equal(acceptAgreementsSchema.safeParse({ acceptTerms: true }).success, false);
  assert.equal(
    acceptAgreementsSchema.safeParse({ acceptTerms: false, acceptPrivacy: true }).success,
    false,
  );
});

await test('until they agree, a member can read who they are and agree, and nothing else', async (t) => {
  const redis = {
    defineCommand: () => {},
    rateLimit: (...args: unknown[]) => {
      (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
    },
  } as unknown as Redis;
  const { service } = setup();
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
      tenant: async (host) => {
        if (host !== 'localhost') throw new AppError(404, 'TENANT_NOT_FOUND');
        return {
          id: agency,
          hostname: host,
          name: 'MSBD',
          locale: 'bn',
          publicConfig: { branches: [], successStories: [] },
        };
      },
    },
    auth: authFor(async (_agency, token) => {
      if (token !== 'valid.jwt.token') throw new AppError(401, 'INVALID_ACCESS_TOKEN');
      return { ...account, role: 'member' };
    }),
    access: unusedAccess,
    agreements: service,
  });
  t.after(() => app.close());
  app.get('/api/v1/other', async () => ({ ok: true }));
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token' },
    });

  assert.equal((await call('GET', '/api/v1/me')).statusCode, 200);
  const blocked = await call('GET', '/api/v1/other');
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, 'AGREEMENT_REQUIRED');
  assert.equal((await call('GET', '/api/v1/me/agreements')).json().required, true);
  assert.equal(
    (await call('POST', '/api/v1/me/agreements', { acceptTerms: true })).statusCode,
    400,
  );
  const done = await call('POST', '/api/v1/me/agreements', {
    acceptTerms: true,
    acceptPrivacy: true,
  });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().required, false);
  assert.equal((await call('GET', '/api/v1/other')).statusCode, 200);
});
