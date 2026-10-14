import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { migrate } from '../../scripts/migrate.js';
import { loadConfig } from '../../src/config/env.js';
import { buildApp } from '../../src/controller/app.js';
import { SessionRepository } from '../../src/cache/repository/session-repository.js';
import { ThrottleRepository } from '../../src/cache/repository/throttle-repository.js';
import { Database } from '../../src/db/config/database.js';
import { CredentialRepository } from '../../src/db/raw/repository/credential-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { IdentityRepository } from '../../src/db/raw/repository/identity-repository.js';
import { RegistrationRepository } from '../../src/db/raw/repository/registration-repository.js';
import { StaffInvitationRepository } from '../../src/db/raw/repository/staff-invitation-repository.js';
import { CredentialDbService } from '../../src/db/service/credential-db-service.js';
import { EventDbService } from '../../src/db/service/event-db-service.js';
import { IdentityDbService } from '../../src/db/service/identity-db-service.js';
import { StaffInvitationDbService } from '../../src/db/service/staff-invitation-db-service.js';
import type { MailMessage } from '../../src/mail/mailer.js';
import { AuthProcess } from '../../src/process/auth-process.js';
import { StaffInvitationProcess } from '../../src/process/staff-invitation-process.js';
import { ClientLoginProcess } from '../../src/process/client-login-process.js';
import { ClientLoginService } from '../../src/service/client-login-service.js';
import { ClientLoginDbService } from '../../src/db/service/client-login-db-service.js';
import { ClientLoginRepository } from '../../src/db/raw/repository/client-login-repository.js';
import type { SmsMessage } from '../../src/sms/sender.js';
import { AccessTokens, parseSigningKey } from '../../src/security/access-token.js';
import { PasswordHasher } from '../../src/security/password-hasher.js';
import { CredentialService } from '../../src/service/credential-service.js';
import { IdentityService } from '../../src/service/identity-service.js';
import { StaffInvitationService } from '../../src/service/staff-invitation-service.js';
import {
  agency,
  env,
  otherAgency,
  unusedAccess,
  unusedClients,
  unusedCandidates,
  unusedMatches,
  unusedConnections,
  unusedPhotos,
  unusedCvs,
  unusedLive,
  unusedProfiles,
  unusedReviews,
} from '../fixtures.js';

// Inviting staff over HTTP with real PostgreSQL and real Redis; only email is captured.
const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');
if (!redisUrl) throw new Error('Set TEST_REDIS_URL to a Redis that is safe to write test keys to');

const password = 'a long and strong password';

await test('inviting staff, over HTTP, on real PostgreSQL and Redis', async (t) => {
  await migrate(databaseUrl, false);
  const owner = new Pool({ connectionString: databaseUrl, max: 1 });
  await owner.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scaffold_test_app') THEN
 CREATE ROLE scaffold_test_app LOGIN PASSWORD 'test-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
 GRANT matrimony_runtime TO scaffold_test_app;`);
  await owner.query(
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,'test-one','localhost','Test one'),($2,'test-two','other.localhost','Test two') ON CONFLICT(id) DO NOTHING`,
    [agency, otherAgency],
  );
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const db = new Database(new Pool({ connectionString: runtimeUrl.href, max: 8 }));
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

  const hasher = new PasswordHasher({ memory: 64, passes: 1, parallelism: 1 });
  const config = loadConfig({ ...env, ACCESS_TOKEN_TTL_SECONDS: '600' });
  const mails: MailMessage[] = [];
  const throttle = new ThrottleRepository(redis);
  const credentials = new CredentialService(
    new CredentialDbService(db, new CredentialRepository(), new EventRepository()),
    hasher,
    pino({ level: 'silent' }),
  );
  const identities = new IdentityService(new IdentityDbService(db, new IdentityRepository()), {
    localhost: agency,
    'other.localhost': otherAgency,
  });
  const auth = new AuthProcess(
    credentials,
    new AccessTokens(parseSigningKey(config.AUTH_JWT_PRIVATE_KEY)),
    new SessionRepository(redis),
    identities,
    throttle,
    new EventDbService(db, new EventRepository()),
    {
      sessionTtl: config.SESSION_TTL_SECONDS,
      accessTtl: config.ACCESS_TOKEN_TTL_SECONDS,
      maxSessions: config.MAX_SESSIONS_PER_ACCOUNT,
    },
  );
  const invitations = new StaffInvitationProcess(
    new StaffInvitationService(
      new StaffInvitationDbService(
        db,
        new StaffInvitationRepository(),
        new RegistrationRepository(),
        new EventRepository(),
      ),
    ),
    credentials,
    auth,
    throttle,
    {
      send: async (message) => {
        mails.push(message);
      },
    },
    pino({ level: 'silent' }),
  );
  const texts: SmsMessage[] = [];
  const clientLogins = new ClientLoginProcess(
    new ClientLoginService(
      new ClientLoginDbService(
        db,
        new ClientLoginRepository(),
        new RegistrationRepository(),
        new EventRepository(),
      ),
    ),
    credentials,
    auth,
    throttle,
    {
      send: async (message) => {
        mails.push(message);
      },
    },
    {
      send: async (message) => {
        texts.push(message);
      },
    },
    pino({ level: 'silent' }),
  );
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
    identities,
    auth,
    access: unusedAccess,
    invitations,
    clientLogins,
    registrations: { signInMethods: async () => null },
  });
  t.after(async () => {
    await app.close();
    await db.close();
    await owner.end();
    redis.disconnect();
  });

  const run = Date.now().toString(36) + randomUUID().slice(0, 4);
  const email = (name: string) => `${name}.${run}@example.com`;
  // A random start, because the address limits live in Redis and outlast a test run.
  let visitor = 10 + Math.floor(Math.random() * 3_000_000);
  const as = (host = 'localhost') => {
    const remoteAddress = `10.${Math.floor(visitor / 65536) % 256}.${Math.floor(visitor / 256) % 256}.${visitor++ % 256}`;
    return (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      options: { body?: unknown; token?: string } = {},
    ) =>
      app.inject({
        method,
        url,
        remoteAddress,
        ...(options.body === undefined ? {} : { payload: options.body as object }),
        headers: {
          host,
          origin: `http://${host}`,
          ...(options.token && { authorization: `Bearer ${options.token}` }),
        },
      });
  };
  const tokenIn = (message: MailMessage) =>
    /token=([A-Za-z0-9_-]{43})/.exec(message.text)?.[1] ?? '';
  const settle = () => invitations.idle();
  const lastMail = (to: string) => mails.filter((m) => m.to === to).at(-1)!;

  /** An account made directly, so the test can sign in as it. */
  async function account(role: 'admin' | 'agent' | 'member', name: string, agencyId = agency) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO matrimony.accounts(agency_id,id,role,display_name,email,email_verified_at,auth_issuer,auth_subject,status)
       VALUES ($1,$2::uuid,$3,$4,$5,now(),'local',($2::uuid)::text,'active')`,
      [agencyId, id, role, `${role} ${name}`, email(name)],
    );
    await owner.query(
      `INSERT INTO matrimony.account_credentials(agency_id,account_id,password_hash) VALUES ($1,$2,$3)`,
      [agencyId, id, await hasher.hash(password)],
    );
    return id;
  }
  const signIn = async (name: string, host = 'localhost') => {
    const response = await as(host)('POST', '/api/v1/auth/login', {
      body: { email: email(name), password },
    });
    assert.equal(response.statusCode, 200, `sign in ${name}`);
    return response.json().accessToken as string;
  };
  const invite = (token: string, name: string, over: Record<string, unknown> = {}, visit = as()) =>
    visit('POST', '/api/v1/admin/staff/invitations', {
      token,
      body: {
        email: email(name),
        displayName: `Invited ${name}`,
        role: 'agent',
        locale: 'en',
        ...over,
      },
    });
  const accept = (link: string, over: Record<string, unknown> = {}, visit = as()) =>
    visit('POST', '/api/v1/auth/staff-invitation/accept', {
      body: { token: link, password, ...over },
    });
  const openRows = async (name: string) =>
    (
      await owner.query(
        `SELECT * FROM matrimony.staff_invitations WHERE agency_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [agency, email(name)],
      )
    ).rows;

  const boss = await account('admin', 'boss');
  const bossToken = await signIn('boss');

  await t.test(
    'an admin invites, the person opens the link, chooses a password and is signed in as staff',
    async () => {
      const created = await invite(bossToken, 'agent1');
      assert.equal(created.statusCode, 201);
      assert.deepEqual(Object.keys(created.json()).sort(), [
        'createdAt',
        'displayName',
        'email',
        'expiresAt',
        'id',
        'invitedByName',
        'locale',
        'role',
        'status',
      ]);
      assert.equal(created.json().status, 'pending');
      assert.equal(created.json().invitedByName, 'admin boss');
      await settle();

      // The email goes to the invited address, names the agency and the inviter, and has the link.
      const mail = lastMail(email('agent1'));
      assert.match(mail.text, /Test one/);
      assert.match(mail.text, /admin boss/);
      assert.match(mail.text, /an agent/);
      assert.match(mail.text, /http:\/\/localhost\/en\/accept-invite\?token=/);
      const link = tokenIn(mail);
      assert.equal(link.length, 43);

      // Only a hash of the secret is stored.
      const [row] = await openRows('agent1');
      assert.equal(row.token_hash.includes(link), false);
      assert.equal(row.role, 'agent');

      const listed = await as()('GET', '/api/v1/admin/staff/invitations', { token: bossToken });
      assert.equal(
        listed.json().invitations.some((i: { email: string }) => i.email === email('agent1')),
        true,
      );

      // Previewing does not use the link up.
      const preview = await as()('POST', '/api/v1/auth/staff-invitation/preview', {
        body: { token: link },
      });
      assert.deepEqual(preview.json(), {
        email: email('agent1'),
        displayName: 'Invited agent1',
        role: 'agent',
      });

      const accepted = await accept(link);
      assert.equal(accepted.statusCode, 200);
      assert.match(
        [accepted.headers['set-cookie']].flat().join(';'),
        /matrimony-session=[A-Za-z0-9_-]{43}/,
      );
      const me = await as()('GET', '/api/v1/me', { token: accepted.json().accessToken });
      assert.equal(me.json().role, 'agent');
      assert.equal(me.json().displayName, 'Invited agent1');

      // The account is verified, active and can log in with the password; the invitation is spent.
      const stored = await owner.query(
        `SELECT status, email_verified_at IS NOT NULL AS verified FROM matrimony.accounts WHERE agency_id=$1 AND email=$2`,
        [agency, email('agent1')],
      );
      assert.deepEqual(stored.rows[0], { status: 'active', verified: true });
      assert.equal((await openRows('agent1')).length, 0);
      // The admin who invited is told that the person joined, and nobody else is.
      const joined = await owner.query(
        `SELECT recipient_account_id, payload FROM matrimony.notifications
          WHERE agency_id=$1 AND template_key='staff.joined' AND payload->>'staffAccountId'=$2`,
        [agency, me.json().id],
      );
      assert.equal(joined.rows.length, 1);
      assert.equal(joined.rows[0].recipient_account_id, boss);
      assert.equal(joined.rows[0].payload.role, 'agent');

      await signIn('agent1');
      // Staff pages are open to the new agent.
      assert.equal(
        (
          await as()('GET', '/api/v1/admin/staff/invitations', {
            token: accepted.json().accessToken,
          })
        ).statusCode,
        403,
      );

      // The link works once.
      assert.equal((await accept(link)).statusCode, 400);
      assert.equal((await accept(link)).json().error.code, 'LINK_INVALID_OR_EXPIRED');
    },
  );

  await t.test(
    'an invited admin becomes an admin; the role comes only from the invitation',
    async () => {
      await invite(bossToken, 'admin2', { role: 'admin' });
      await settle();
      const link = tokenIn(lastMail(email('admin2')));
      assert.match(lastMail(email('admin2')).text, /an admin/);
      // The person accepting cannot choose a role, an agency or anything else.
      for (const extra of [
        { role: 'admin' },
        { agencyId: otherAgency },
        { email: 'x@example.com' },
      ]) {
        assert.equal((await accept(link, extra)).statusCode, 400);
      }
      const accepted = await accept(link);
      assert.equal(accepted.statusCode, 200);
      assert.equal(
        (await as()('GET', '/api/v1/me', { token: accepted.json().accessToken })).json().role,
        'admin',
      );
    },
  );

  await t.test('only an admin can invite, list, resend or cancel', async () => {
    await account('agent', 'plain');
    await account('member', 'person');
    const created = await invite(bossToken, 'target');
    for (const name of ['plain', 'person']) {
      const token = await signIn(name);
      assert.equal((await invite(token, 'blocked')).statusCode, 403, name);
      assert.equal(
        (await as()('GET', '/api/v1/admin/staff/invitations', { token })).statusCode,
        403,
      );
      assert.equal(
        (
          await as()('POST', `/api/v1/admin/staff/invitations/${created.json().id}/resend`, {
            token,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await as()('DELETE', `/api/v1/admin/staff/invitations/${created.json().id}`, { token }))
          .statusCode,
        403,
      );
    }
    assert.equal((await openRows('blocked')).length, 0);
    assert.equal((await as()('GET', '/api/v1/admin/staff/invitations')).statusCode, 401);
  });

  await t.test('an address that already has an account is not invited', async () => {
    await account('member', 'existing');
    const refused = await invite(bossToken, 'existing');
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error.code, 'EMAIL_IN_USE');
    assert.equal((await openRows('existing')).length, 0);
    // The member's role is untouched.
    const role = await owner.query(
      `SELECT role FROM matrimony.accounts WHERE agency_id=$1 AND email=$2`,
      [agency, email('existing')],
    );
    assert.equal(role.rows[0].role, 'member');
  });

  await t.test(
    'inviting the same address again replaces the invitation; the old link stops',
    async () => {
      await invite(bossToken, 'again', { displayName: 'First', role: 'agent' });
      await settle();
      const first = tokenIn(lastMail(email('again')));
      const second = await invite(bossToken, 'again', { displayName: 'Second', role: 'admin' });
      assert.equal(second.statusCode, 201);
      await settle();
      const newest = tokenIn(lastMail(email('again')));
      assert.notEqual(first, newest);
      assert.equal((await openRows('again')).length, 1);
      assert.equal((await accept(first)).statusCode, 400);
      const accepted = await accept(newest);
      assert.equal(accepted.statusCode, 200);
      const me = await as()('GET', '/api/v1/me', { token: accepted.json().accessToken });
      assert.equal(me.json().displayName, 'Second');
      assert.equal(me.json().role, 'admin');
    },
  );

  await t.test('resending gives a new link and the earlier one stops working', async () => {
    const created = await invite(bossToken, 'resent');
    await settle();
    const first = tokenIn(lastMail(email('resent')));
    const again = await as()(
      'POST',
      `/api/v1/admin/staff/invitations/${created.json().id}/resend`,
      {
        token: bossToken,
      },
    );
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().id, created.json().id);
    await settle();
    const newest = tokenIn(lastMail(email('resent')));
    assert.notEqual(first, newest);
    assert.equal((await accept(first)).statusCode, 400);
    assert.equal((await accept(newest)).statusCode, 200);
    // A spent invitation cannot be resent.
    const spent = await as()(
      'POST',
      `/api/v1/admin/staff/invitations/${created.json().id}/resend`,
      {
        token: bossToken,
      },
    );
    assert.equal(spent.statusCode, 404);
    assert.equal(spent.json().error.code, 'INVITATION_NOT_FOUND');
  });

  await t.test('cancelling an invitation ends its link and leaves a record', async () => {
    const created = await invite(bossToken, 'cancelled');
    await settle();
    const link = tokenIn(lastMail(email('cancelled')));
    const gone = await as()('DELETE', `/api/v1/admin/staff/invitations/${created.json().id}`, {
      token: bossToken,
    });
    assert.equal(gone.statusCode, 204);
    assert.equal((await accept(link)).statusCode, 400);
    assert.equal(
      (await as()('POST', '/api/v1/auth/staff-invitation/preview', { body: { token: link } }))
        .statusCode,
      400,
    );
    assert.equal((await openRows('cancelled')).length, 0);
    const kept = await owner.query(
      `SELECT revoked_at IS NOT NULL AS revoked FROM matrimony.staff_invitations WHERE id=$1`,
      [created.json().id],
    );
    assert.equal(kept.rows[0].revoked, true);
    // Cancelling twice, or an unknown one, is not found.
    for (const id of [created.json().id, randomUUID()]) {
      const missing = await as()('DELETE', `/api/v1/admin/staff/invitations/${id}`, {
        token: bossToken,
      });
      assert.equal(missing.statusCode, 404);
    }
    // The address can be invited again afterwards.
    assert.equal((await invite(bossToken, 'cancelled')).statusCode, 201);
  });

  await t.test(
    'an expired invitation is shown as expired, refuses its link and can be resent',
    async () => {
      const created = await invite(bossToken, 'old');
      await settle();
      const link = tokenIn(lastMail(email('old')));
      await owner.query(
        `UPDATE matrimony.staff_invitations SET expires_at = now() - interval '1 minute' WHERE id=$1`,
        [created.json().id],
      );
      const listed = await as()('GET', '/api/v1/admin/staff/invitations', { token: bossToken });
      assert.equal(
        listed.json().invitations.find((i: { id: string }) => i.id === created.json().id).status,
        'expired',
      );
      assert.equal((await accept(link)).statusCode, 400);
      const resent = await as()(
        'POST',
        `/api/v1/admin/staff/invitations/${created.json().id}/resend`,
        {
          token: bossToken,
        },
      );
      assert.equal(resent.statusCode, 200);
      assert.equal(resent.json().status, 'pending');
      await settle();
      assert.equal((await accept(tokenIn(lastMail(email('old'))))).statusCode, 200);
    },
  );

  await t.test('two requests with the same link create exactly one account', async () => {
    await invite(bossToken, 'race');
    await settle();
    const link = tokenIn(lastMail(email('race')));
    const results = await Promise.all([accept(link), accept(link), accept(link)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 400, 400]);
    const accounts = await owner.query(
      `SELECT count(*)::int AS n FROM matrimony.accounts WHERE agency_id=$1 AND email=$2`,
      [agency, email('race')],
    );
    assert.equal(accounts.rows[0].n, 1);
  });

  await t.test(
    'an address that got an account after the invitation was sent is not taken over',
    async () => {
      await invite(bossToken, 'late');
      await settle();
      const link = tokenIn(lastMail(email('late')));
      await account('member', 'late');
      assert.equal((await accept(link)).statusCode, 400);
      const stored = await owner.query(
        `SELECT role FROM matrimony.accounts WHERE agency_id=$1 AND email=$2`,
        [agency, email('late')],
      );
      assert.deepEqual(
        stored.rows.map((r) => r.role),
        ['member'],
      );
    },
  );

  await t.test('a password that is the email is refused and the link still works', async () => {
    await invite(bossToken, 'weak');
    await settle();
    const link = tokenIn(lastMail(email('weak')));
    const local = email('weak').split('@')[0]!;
    const refused = await accept(link, { password: local });
    assert.equal(refused.statusCode, 400);
    assert.deepEqual(refused.json().error.details.fields, [
      { path: 'password', code: 'sameAsEmail' },
    ]);
    assert.equal((await openRows('weak')).length, 1);
    assert.equal((await accept(link, { password: 'short' })).statusCode, 400);
    assert.equal((await openRows('weak')).length, 1);
    assert.equal((await accept(link)).statusCode, 200);
  });

  await t.test('a link belongs to its agency: it does nothing on another one', async () => {
    await invite(bossToken, 'tenant');
    await settle();
    const link = tokenIn(lastMail(email('tenant')));
    const elsewhere = await accept(link, {}, as('other.localhost'));
    assert.equal(elsewhere.statusCode, 400);
    assert.equal((await openRows('tenant')).length, 1);
    // Another agency's rows are invisible to this agency, even to a direct query.
    const seen = await db.transaction(otherAgency, async (tx) =>
      Number(
        (
          await tx.query(`SELECT count(*) AS n FROM matrimony.staff_invitations WHERE email=$1`, [
            email('tenant'),
          ])
        ).rows[0].n,
      ),
    );
    assert.equal(seen, 0);
    // An admin of the other agency cannot see or cancel it either.
    await account('admin', 'foreignboss', otherAgency);
    const foreignToken = await signIn('foreignboss', 'other.localhost');
    const foreign = as('other.localhost');
    const listed = await foreign('GET', '/api/v1/admin/staff/invitations', { token: foreignToken });
    assert.equal(
      listed.json().invitations.some((i: { email: string }) => i.email === email('tenant')),
      false,
    );
    const id = (await openRows('tenant'))[0].id;
    assert.equal(
      (await foreign('DELETE', `/api/v1/admin/staff/invitations/${id}`, { token: foreignToken }))
        .statusCode,
      404,
    );
  });

  await t.test('sending is limited, and the origin of a browser call is checked', async () => {
    const results: number[] = [];
    for (let i = 0; i < 5; i++) results.push((await invite(bossToken, 'limited')).statusCode);
    assert.deepEqual(results, [201, 201, 201, 429, 429]);
    // The public pages refuse a call from another site.
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/staff-invitation/accept',
      headers: { host: 'localhost', origin: 'http://evil.example' },
      payload: { token: 'a'.repeat(43), password },
    });
    assert.equal(crossSite.statusCode, 403);
  });

  await t.test('the audit trail has ids only, never an address or a link', async () => {
    const events = await owner.query(
      `SELECT event FROM matrimony.event_outbox WHERE event->>'type' LIKE 'staff.%' AND event->>'actorId'=$1`,
      [boss],
    );
    const types = new Set(events.rows.map((r) => r.event.type));
    assert.equal(types.has('staff.invited'), true);
    assert.equal(types.has('staff.invitation_revoked'), true);
    assert.equal(JSON.stringify(events.rows).includes('@example.com'), false);
    const accepted = await owner.query(
      `SELECT count(*)::int AS n FROM matrimony.event_outbox WHERE event->>'type'='staff.invitation_accepted'`,
    );
    assert.ok(accepted.rows[0].n >= 1);
  });

  /** A client the agency runs, with no account, looked after by the given agent. */
  async function assistedClient(name: string, agentId: string | null) {
    const id = randomUUID();
    const creator = await account('admin', `creator-${name.toLowerCase().replace(/ /g, '-')}`);
    await owner.query(
      `INSERT INTO matrimony.member_profiles
         (agency_id, id, member_code, created_by_account_id, assigned_agent_id, service_mode, status, full_name)
       VALUES ($1, $2, $3, $4, $5, 'assisted', 'active', $6)`,
      [agency, id, `M${Math.floor(Math.random() * 9_000_000) + 1_000_000}`, creator, agentId, name],
    );
    return id;
  }
  const asStaff = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    as()(method, url, { token, ...(body === undefined ? {} : { body }) });

  await t.test(
    'an agent gives a client with no login one, and the client opens the link',
    async () => {
      const agent = await account('agent', 'logins-agent');
      await account('agent', 'logins-rival');
      const agentToken = await signIn('logins-agent');
      const rivalToken = await signIn('logins-rival');
      const profileId = await assistedClient('Tania Client', agent);
      const url = `/api/v1/staff/clients/${profileId}/login`;

      // Before: no login and none out, and this client can be given one.
      const before = await asStaff(agentToken, 'GET', url);
      assert.equal(before.statusCode, 200);
      assert.deepEqual([before.json().state, before.json().canGrant], ['none', true]);

      // An agent who does not look after the client is told there is no such client.
      assert.equal((await asStaff(rivalToken, 'GET', url)).statusCode, 404);
      const rivalTry = await asStaff(rivalToken, 'POST', url, {
        channel: 'email',
        email: email('nope'),
        locale: 'en',
      });
      assert.equal(rivalTry.statusCode, 404);

      // The link goes by email, to the address the agent typed.
      const address = email('client-one');
      const sent = await asStaff(agentToken, 'POST', url, {
        channel: 'email',
        email: address,
        locale: 'en',
      });
      assert.equal(sent.statusCode, 201);
      assert.deepEqual(
        [sent.json().state, sent.json().channel, sent.json().address],
        ['invited', 'email', address],
      );
      await clientLogins.idle();
      const message = lastMail(address);
      assert.match(message.text, /accept-login\?token=/);
      const token = tokenIn(message);
      assert.equal(token.length, 43);

      // The page greets the client by name, and previewing does not use the link up.
      const preview = await as()('POST', '/api/v1/auth/client-login/preview', { body: { token } });
      assert.deepEqual(preview.json(), {
        displayName: 'Tania Client',
        channel: 'email',
        locale: 'en',
      });

      // The terms must be accepted, and the password must be a real one.
      const accept = (over: Record<string, unknown> = {}) =>
        as()('POST', '/api/v1/auth/client-login/accept', {
          body: { token, password, acceptTerms: true, acceptPrivacy: true, ...over },
        });
      assert.equal((await accept({ acceptTerms: false })).statusCode, 400);
      assert.equal((await accept({ password: '12345' })).statusCode, 400);

      const accepted = await accept();
      assert.equal(accepted.statusCode, 200);
      assert.match(
        [accepted.headers['set-cookie']].flat().join(';'),
        /matrimony-session=[A-Za-z0-9_-]{43}/,
      );
      const me = await as()('GET', '/api/v1/me', { token: accepted.json().accessToken });
      assert.equal(me.json().role, 'member');
      assert.equal(me.json().displayName, 'Tania Client');

      // The account is the profile's owner; the profile stays an assisted one with the same agent.
      const stored = await owner.query(
        `SELECT owner_account_id, service_mode, assigned_agent_id FROM matrimony.member_profiles WHERE agency_id=$1 AND id=$2`,
        [agency, profileId],
      );
      assert.equal(stored.rows[0].owner_account_id, me.json().id);
      assert.equal(stored.rows[0].service_mode, 'assisted');
      assert.equal(stored.rows[0].assigned_agent_id, agent);
      // What was agreed to is on record.
      const consents = await owner.query(
        `SELECT purpose FROM matrimony.consent_events WHERE agency_id=$1 AND account_id=$2 ORDER BY purpose`,
        [agency, me.json().id],
      );
      assert.deepEqual(
        consents.rows.map((r) => r.purpose),
        ['privacy', 'terms'],
      );
      // The password works for signing in again.
      const again = await as()('POST', '/api/v1/auth/login', {
        body: { email: address, password },
      });
      assert.equal(again.statusCode, 200);

      // The link works once, and the client now has a login.
      assert.equal((await accept()).statusCode, 400);
      const after = await asStaff(agentToken, 'GET', url);
      assert.deepEqual(
        [after.json().state, after.json().canGrant, after.json().accountName],
        ['active', false, 'Tania Client'],
      );
      const second = await asStaff(agentToken, 'POST', url, {
        channel: 'email',
        email: email('again'),
        locale: 'en',
      });
      assert.equal(second.statusCode, 409);
    },
  );

  await t.test(
    'a link by text message, sent again and cancelled, and an address in use',
    async () => {
      const agent = await account('agent', 'sms-agent');
      const agentToken = await signIn('sms-agent');
      const profileId = await assistedClient('Sms Client', agent);
      const url = `/api/v1/staff/clients/${profileId}/login`;
      const phone = '+8801711' + String(Math.floor(Math.random() * 900000) + 100000);
      const tokenOf = (text: string) => /token=([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? '';

      const first = await asStaff(agentToken, 'POST', url, { channel: 'sms', phone, locale: 'bn' });
      assert.equal(first.statusCode, 201);
      await clientLogins.idle();
      const firstToken = tokenOf(texts.at(-1)!.text);
      assert.equal(texts.at(-1)!.to, phone);
      assert.ok(firstToken);

      // Sending again replaces the link: the earlier one stops working.
      await asStaff(agentToken, 'POST', url, { channel: 'sms', phone, locale: 'bn' });
      await clientLogins.idle();
      const secondToken = tokenOf(texts.at(-1)!.text);
      assert.notEqual(secondToken, firstToken);
      const old = await as()('POST', '/api/v1/auth/client-login/preview', {
        body: { token: firstToken },
      });
      assert.equal(old.statusCode, 400);

      // Cancelling takes the link away.
      assert.equal((await asStaff(agentToken, 'DELETE', url)).statusCode, 204);
      const gone = await as()('POST', '/api/v1/auth/client-login/preview', {
        body: { token: secondToken },
      });
      assert.equal(gone.statusCode, 400);
      assert.equal((await asStaff(agentToken, 'DELETE', url)).statusCode, 404);

      // An address that another account already uses is refused when the link is opened.
      await account('member', 'taken-address');
      const taken = email('taken-address');
      const second = await asStaff(agentToken, 'POST', url, {
        channel: 'email',
        email: taken,
        locale: 'en',
      });
      assert.equal(second.statusCode, 201);
      await clientLogins.idle();
      const refused = await as()('POST', '/api/v1/auth/client-login/accept', {
        body: { token: tokenIn(lastMail(taken)), password, acceptTerms: true, acceptPrivacy: true },
      });
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.json().error.code, 'ADDRESS_IN_USE');
      // Nothing was attached: the client still has no login.
      const still = await asStaff(agentToken, 'GET', url);
      assert.equal(still.json().state, 'invited');
    },
  );

  await t.test(
    'only a client the agency runs, and with no account, can be given a login',
    async () => {
      await account('admin', 'logins-boss');
      const bossToken = await signIn('logins-boss');
      const member = await account('member', 'logins-member');
      const ownProfile = randomUUID();
      await owner.query(
        `INSERT INTO matrimony.member_profiles
         (agency_id, id, member_code, owner_account_id, created_by_account_id, service_mode, status, full_name)
       VALUES ($1, $2, $3, $4, $4, 'self_service', 'active', 'Runs Own')`,
        [agency, ownProfile, `M${Math.floor(Math.random() * 9_000_000) + 1_000_000}`, member],
      );
      const url = `/api/v1/staff/clients/${ownProfile}/login`;
      const status = await asStaff(bossToken, 'GET', url);
      assert.deepEqual([status.json().state, status.json().canGrant], ['active', false]);
      const refused = await asStaff(bossToken, 'POST', url, {
        channel: 'email',
        email: email('own'),
        locale: 'en',
      });
      assert.equal(refused.statusCode, 409);
      // A member cannot give anyone a login.
      const memberToken = await signIn('logins-member');
      const byMember = await asStaff(memberToken, 'POST', url, {
        channel: 'email',
        email: email('x'),
        locale: 'en',
      });
      assert.equal(byMember.statusCode, 403);
    },
  );

  await t.test(
    'the application role cannot delete invitations or change who they are for',
    async () => {
      const denied = async (sql: string) =>
        db
          .transaction(agency, (tx) => tx.query(sql))
          .then(
            () => false,
            () => true,
          );
      assert.equal(await denied(`DELETE FROM matrimony.staff_invitations`), true);
      assert.equal(
        await denied(`UPDATE matrimony.staff_invitations SET email='x@example.com'`),
        true,
      );
    },
  );
});
