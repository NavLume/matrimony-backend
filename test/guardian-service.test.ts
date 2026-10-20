import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowEvent } from '../src/bo/event.js';
import { adviceInputSchema } from '../src/bo/guardian.js';
import type { GuardedProfile, GuardianRow } from '../src/db/raw/repository/guardian-repository.js';
import type { GuardianUnit } from '../src/db/service/guardian-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { GuardianService } from '../src/service/guardian-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = ID(1);
const SALMA = ID(11);
const KAMAL = ID(12);
const OWNER = ID(21);
const GUARDIAN = ID(31);
const CLIENT = ID(201);
const PROPOSAL = ID(300);

const actor = (role: 'admin' | 'agent' | 'member' | 'guardian', accountId: string) => ({
  agencyId: agency,
  accountId,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;
const invite = { email: 'father@example.test', displayName: 'Abdul', locale: 'en' as const };

function setup(
  options: { login?: boolean; existingEmail?: boolean; proposal?: string | null } = {},
) {
  const login = options.login ?? true;
  const profile: GuardedProfile = {
    id: CLIENT,
    fullName: 'Rahim',
    memberCode: 'M1',
    serviceMode: login ? 'self_service' : 'assisted',
    ownerAccountId: login ? OWNER : null,
    assignedAgentId: SALMA,
  };
  const state = {
    guardian: null as GuardianRow | null,
    events: [] as WorkflowEvent[],
    told: [] as string[],
    consents: [] as unknown[],
    advice: [] as unknown[],
    tokenHashStored: null as string | null,
  };
  const unit = {
    profile: async (_a: string, id: string) => (id === CLIENT ? profile : null),
    ownProfile: async (_a: string, account: string) => (account === OWNER ? profile : null),
    // A copy, as a database row is: a later change must not alter what was read.
    current: async () =>
      state.guardian && state.guardian.status !== 'removed' ? { ...state.guardian } : null,
    accountExists: async () => options.existingEmail ?? false,
    insert: async (
      _a: string,
      g: {
        email: string;
        displayName: string;
        status: string;
        consentBasis: string | null;
        tokenHash: string | null;
        locale: 'bn' | 'en';
      },
    ) => {
      state.tokenHashStored = g.tokenHash;
      state.guardian = {
        id: ID(400),
        profileId: CLIENT,
        email: g.email,
        displayName: g.displayName,
        locale: g.locale,
        status: g.status as never,
        consentBasis: g.consentBasis as never,
        consentedAt: null,
        expiresAt: null,
        expired: false,
        accountId: null,
      };
      return ID(400);
    },
    consent: async (_a: string, _id: string, basis: string, _by: string, hash: string) => {
      state.guardian!.status = 'invited';
      state.guardian!.consentBasis = basis as never;
      state.tokenHashStored = hash;
    },
    reissue: async (_a: string, _id: string, hash: string) => void (state.tokenHashStored = hash),
    remove: async () => void (state.guardian!.status = 'removed'),
    notifyClientApproval: async () => void state.told.push('ask-client'),
    notifyAnswer: async (_a: string, _p: string, _id: string, answer: string) =>
      void state.told.push(`answer:${answer}`),
    notifyAdvice: async () => void state.told.push('advice'),
    guardedBy: async (_a: string, account: string) => (account === GUARDIAN ? profile : null),
    receivedProposal: async (_a: string, id: string) =>
      id === PROPOSAL ? (options.proposal === undefined ? 'pending' : options.proposal) : null,
    saveAdvice: async (...args: unknown[]) => void state.advice.push(args),
    byLink: async () => ({
      id: ID(400),
      email: invite.email,
      displayName: invite.displayName,
      locale: 'en' as const,
    }),
    createAccount: async () => ({
      id: GUARDIAN,
      role: 'guardian',
      agencyId: agency,
      displayName: 'Abdul',
    }),
    createCredential: async () => undefined,
    recordConsents: async (_a: string, _acc: string, records: unknown[]) =>
      void state.consents.push(...records),
    markAccepted: async () => true,
    appendEvent: async (event: WorkflowEvent) => void state.events.push(event),
  };
  const db = {
    inTransaction: async <T>(_agency: string, work: (u: GuardianUnit) => Promise<T>) =>
      work(unit as unknown as GuardianUnit),
  };
  let n = 800;
  const service = new GuardianService(
    db,
    () => new Date('2026-10-20T10:00:00Z'),
    () => ID(n++),
    async () => ({ terms: 'agency-v2', privacy: 'draft-2026-10' }),
  );
  return { state, service };
}

await test('for a client who signs in, the request waits for the client before any email goes out', async () => {
  const { service, state } = setup();
  const result = await service.invite(actor('agent', SALMA), CLIENT, invite, 'hash', 'r');
  assert.equal(result.state.state, 'awaiting_client');
  assert.equal(result.send, null);
  assert.equal(state.tokenHashStored, null);
  assert.deepEqual(state.told, ['ask-client']);
  assert.equal(state.events[0]?.type, 'guardian.requested');

  const approved = await service.approve(actor('member', OWNER), 'client-hash', 'r2');
  assert.equal(approved.send.email, invite.email);
  assert.equal(approved.state.state, 'invited');
  assert.equal(approved.state.consentBasis, 'client_in_app');
  assert.equal(state.tokenHashStored, 'client-hash');
  assert.ok(state.told.includes('answer:approved'));
});

await test('for a client with no login the agent must confirm the client agreed, and the email goes out at once', async () => {
  const { service, state } = setup({ login: false });
  await assert.rejects(
    () => service.invite(actor('agent', SALMA), CLIENT, invite, 'hash', 'r'),
    code(400, 'INVALID_REQUEST'),
  );
  const result = await service.invite(
    actor('agent', SALMA),
    CLIENT,
    { ...invite, clientAgreed: true },
    'hash',
    'r',
  );
  assert.equal(result.state.state, 'invited');
  assert.equal(result.state.consentBasis, 'agent_recorded');
  assert.equal(result.send?.clientName, 'Rahim');
  assert.equal(state.tokenHashStored, 'hash');
  assert.equal(state.events[0]?.type, 'guardian.invited');
});

await test('one guardian per profile, an address with an account is never invited, and only staff of the client ask', async () => {
  const { service } = setup();
  await service.invite(actor('admin', ADMIN), CLIENT, invite, 'h', 'r');
  await assert.rejects(
    () => service.invite(actor('admin', ADMIN), CLIENT, invite, 'h', 'r'),
    code(409, 'GUARDIAN_EXISTS'),
  );

  const taken = setup({ existingEmail: true });
  await assert.rejects(
    () => taken.service.invite(actor('admin', ADMIN), CLIENT, invite, 'h', 'r'),
    code(409, 'EMAIL_IN_USE'),
  );
  const other = setup();
  await assert.rejects(
    () => other.service.invite(actor('agent', KAMAL), CLIENT, invite, 'h', 'r'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    () => other.service.invite(actor('member', OWNER), CLIENT, invite, 'h', 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
});

await test('the client can decline a request, which tells the agent, and can remove an accepted guardian', async () => {
  const { service, state } = setup();
  await service.invite(actor('agent', SALMA), CLIENT, invite, 'h', 'r');
  const declined = await service.removeByClient(actor('member', OWNER), 'r2');
  assert.equal(declined.state, 'none');
  assert.ok(state.told.includes('answer:rejected'));
  await assert.rejects(
    () => service.removeByClient(actor('member', OWNER), 'r3'),
    code(404, 'GUARDIAN_NOT_FOUND'),
  );
  await assert.rejects(
    () => service.approve(actor('member', OWNER), 'x', 'r'),
    code(404, 'GUARDIAN_NOT_FOUND'),
  );
});

await test('staff can send the link again only while an invitation is out, and can end it', async () => {
  const { service, state } = setup({ login: false });
  await assert.rejects(
    () => service.resend(actor('agent', SALMA), CLIENT, 'h2', 'r'),
    code(404, 'GUARDIAN_NOT_FOUND'),
  );
  await service.invite(actor('agent', SALMA), CLIENT, { ...invite, clientAgreed: true }, 'h1', 'r');
  const again = await service.resend(actor('agent', SALMA), CLIENT, 'h2', 'r');
  assert.equal(again.send.email, invite.email);
  assert.equal(state.tokenHashStored, 'h2');
  const removed = await service.removeByStaff(actor('agent', SALMA), CLIENT, 'r');
  assert.equal(removed.state, 'none');
  assert.equal(state.events.at(-1)?.type, 'guardian.removed');
});

await test('accepting the invitation records the terms version current for the agency', async () => {
  const { service, state } = setup();
  const account = await service.accept(agency, 'hash', 'pw-hash', 'r');
  assert.equal(account?.role, 'guardian');
  assert.deepEqual(state.consents, [
    { purpose: 'terms', documentVersion: 'agency-v2' },
    { purpose: 'privacy', documentVersion: 'draft-2026-10' },
  ]);
  assert.equal(state.events.at(-1)?.type, 'guardian.accepted');
});

await test('a guardian advises on a waiting proposal their client received, and only a guardian can', async () => {
  const { service, state } = setup();
  await service.advise(
    actor('guardian', GUARDIAN),
    PROPOSAL,
    adviceInputSchema.parse({ advice: 'supportive', note: 'Good family' }),
    'r',
  );
  assert.equal(state.advice.length, 1);
  assert.ok(state.told.includes('advice'));
  assert.equal(state.events.at(-1)?.type, 'guardian.advised');
  await assert.rejects(
    () =>
      service.advise(
        actor('member', OWNER),
        PROPOSAL,
        adviceInputSchema.parse({ advice: 'supportive' }),
        'r',
      ),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    () =>
      service.advise(
        actor('guardian', GUARDIAN),
        ID(999),
        adviceInputSchema.parse({ advice: 'supportive' }),
        'r',
      ),
    code(404, 'CONNECTION_NOT_FOUND'),
  );
  await assert.rejects(
    () =>
      service.advise(
        actor('guardian', ID(32)),
        PROPOSAL,
        adviceInputSchema.parse({ advice: 'supportive' }),
        'r',
      ),
    code(404, 'PROFILE_NOT_FOUND'),
  );

  const answered = setup({ proposal: 'accepted' });
  await assert.rejects(
    () =>
      answered.service.advise(
        actor('guardian', GUARDIAN),
        PROPOSAL,
        adviceInputSchema.parse({ advice: 'concerned' }),
        'r',
      ),
    code(409, 'PROPOSAL_NOT_OPEN'),
  );
});

await test('the guardian sees whom they look after', async () => {
  const { service } = setup();
  const ward = await service.ward(actor('guardian', GUARDIAN));
  assert.equal(ward.fullName, 'Rahim');
  await assert.rejects(() => service.ward(actor('agent', SALMA)), code(403, 'ROLE_FORBIDDEN'));
});
