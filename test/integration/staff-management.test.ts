import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { matchQuerySchema } from '../../src/bo/matches.js';
import { profileInputSchema } from '../../src/bo/profile.js';
import { Database } from '../../src/db/config/database.js';
import { CandidateRepository } from '../../src/db/raw/repository/candidate-repository.js';
import { ClientRepository } from '../../src/db/raw/repository/client-repository.js';
import { ConnectionRepository } from '../../src/db/raw/repository/connection-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { MatchRepository } from '../../src/db/raw/repository/match-repository.js';
import { ProfileRepository } from '../../src/db/raw/repository/profile-repository.js';
import { ReviewRepository } from '../../src/db/raw/repository/review-repository.js';
import { CandidateDbService } from '../../src/db/service/candidate-db-service.js';
import { ClientDbService } from '../../src/db/service/client-db-service.js';
import { ConnectionDbService } from '../../src/db/service/connection-db-service.js';
import { MatchDbService } from '../../src/db/service/match-db-service.js';
import { ProfileDbService } from '../../src/db/service/profile-db-service.js';
import { ReviewDbService } from '../../src/db/service/review-db-service.js';
import { clientInputSchema } from '../../src/bo/client.js';
import { notificationQuerySchema } from '../../src/bo/connection.js';
import { RegistrationRepository } from '../../src/db/raw/repository/registration-repository.js';
import { StaffInvitationRepository } from '../../src/db/raw/repository/staff-invitation-repository.js';
import { StaffInvitationDbService } from '../../src/db/service/staff-invitation-db-service.js';
import { StaffInvitationService } from '../../src/service/staff-invitation-service.js';
import { listenClientFor, NotificationHub } from '../../src/notify/notification-hub.js';
import { PasswordHasher } from '../../src/security/password-hasher.js';
import { AppError } from '../../src/exception/app-error.js';
import { CandidateService } from '../../src/service/candidate-service.js';
import { ClientService } from '../../src/service/client-service.js';
import { ConnectionService } from '../../src/service/connection-service.js';
import { MatchService } from '../../src/service/match-service.js';
import { ProfileService, type ProfileActor } from '../../src/service/profile-service.js';
import { ReviewService } from '../../src/service/review-service.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const NOW = new Date();
const refused = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('staff management, the nightly refresh and code search on real PostgreSQL', async (t) => {
  await migrate(databaseUrl, false);
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scaffold_test_app') THEN
 CREATE ROLE scaffold_test_app LOGIN PASSWORD 'test-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
 GRANT matrimony_runtime TO scaffold_test_app;`);

  // Every run gets its own agencies, so profiles left by earlier runs never take part.
  const tag = randomUUID().slice(0, 8);
  const agencyId = randomUUID();
  const elsewhereId = randomUUID();
  await admin.query(
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,$2,$3,'Connect one'),($4,$5,$6,'Connect two')`,
    [
      agencyId,
      `sm-${tag}`,
      `sm-${tag}.localhost`,
      elsewhereId,
      `sm2-${tag}`,
      `sm2-${tag}.localhost`,
    ],
  );
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const pool = new Pool({ connectionString: runtimeUrl.href, max: 10 });
  const db = new Database(pool);
  t.after(async () => {
    await db.close();
    await admin.end();
  });

  const profiles = new ProfileService(
    new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
  );
  const reviews = new ReviewService(
    new ReviewDbService(db, new ReviewRepository(), new ProfileRepository(), new EventRepository()),
  );
  const clients = new ClientService(
    new ClientDbService(db, new ClientRepository(), new EventRepository()),
    profiles,
  );
  const candidates = new CandidateService(
    new CandidateDbService(db, new CandidateRepository(), new EventRepository()),
    pino({ level: 'silent' }),
  );
  const matches = new MatchService(
    new MatchDbService(db, new MatchRepository(), new CandidateRepository()),
  );
  const connections = new ConnectionService(
    new ConnectionDbService(
      db,
      new ConnectionRepository(),
      new MatchRepository(),
      new CandidateRepository(),
      new EventRepository(),
    ),
  );

  const account = async (role: ProfileActor['role'], name: string, inAgency = agencyId) => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO matrimony.accounts(id,agency_id,role,display_name,status,email,auth_issuer,auth_subject)
       VALUES ($1,$2,$3,$4,'active',$5,'https://test.example',$6)`,
      [id, inAgency, role, name, `${id}@example.com`, id],
    );
    return { id, actor: { agencyId: inAgency, accountId: id, role } as ProfileActor };
  };
  const boss = await account('admin', 'Boss');
  const abir = await account('agent', 'Abir');
  const rival = await account('agent', 'Rival');
  const foreignBoss = await account('admin', 'Foreign boss', elsewhereId);

  const BASE = {
    maritalStatus: 'never_married',
    heightCm: 165,
    religionCode: 'islam',
    currentDistrictCode: 'dhaka',
    highestDegreeCode: 'bachelors',
    occupationCode: 'salaried',
    dateOfBirth: '1996-01-01',
  };
  /** A member who runs their own profile, published. Their contact details are secrets that must stay hidden. */
  const member = async (name: string, gender: 'male' | 'female', inAgency = agencyId) => {
    const me = await account('member', name, inAgency);
    const saved = await profiles.save(
      me.actor,
      profileInputSchema(NOW).parse({
        profile: { fullName: name, ...BASE, gender },
        contact: {
          contactName: `${name} contact`,
          contactRelationship: 'self',
          phone: '+8801711111111',
          email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`,
          permanentAddress: `SECRET ADDRESS of ${name}`,
        },
      }),
    );
    const sent = await profiles.submit(me.actor, saved.profile!.version, 'c');
    await reviews.approve(
      inAgency === agencyId ? boss.actor : foreignBoss.actor,
      sent.pendingReview!.id,
      {},
      'c',
    );
    return { ...me, name, profileId: saved.profile!.id };
  };
  /** Puts `other` in `of`'s released window. */
  const release = async (of: string, other: string) => {
    await candidates.generate(boss.actor, of);
    await candidates.release(boss.actor, of, { candidateIds: [other] }, 'c');
  };
  const m1 = await member('Mahir One', 'male');
  const m2 = await member('Nila Two', 'female');
  const m3 = await member('Tara Three', 'female');
  const status = async (id: string) =>
    (await admin.query(`SELECT status FROM matrimony.accounts WHERE id = $1`, [id])).rows[0].status;
  const agentOf = async (profileId: string) =>
    (
      await admin.query(`SELECT assigned_agent_id FROM matrimony.member_profiles WHERE id = $1`, [
        profileId,
      ])
    ).rows[0].assigned_agent_id as string | null;

  await t.test(
    'assigning is recorded as a history, and choosing the same agent again is not',
    async () => {
      await clients.assign(boss.actor, m2.profileId, abir.id, 'c');
      await clients.assign(boss.actor, m2.profileId, abir.id, 'c');
      await clients.assign(boss.actor, m2.profileId, rival.id, 'c');
      const trail = await clients.assignments(boss.actor, m2.profileId);
      assert.deepEqual(
        trail.map((r) => [
          r.from?.displayName ?? null,
          r.to?.displayName ?? null,
          r.by?.displayName,
        ]),
        [
          ['Abir', 'Rival', 'Boss'],
          ['Rival', 'Abir', 'Boss'],
          // Registering gave the profile its first agent, with nobody as the person who did it.
          [null, 'Rival', undefined],
        ],
      );
      // Only an admin and the agent who looks after them now read it.
      assert.equal((await clients.assignments(rival.actor, m2.profileId)).length, 3);
      await assert.rejects(
        clients.assignments(abir.actor, m2.profileId),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        clients.assignments(m1.actor, m2.profileId),
        refused(403, 'ROLE_FORBIDDEN'),
      );
      // Another agency never sees it.
      await assert.rejects(
        clients.assignments(foreignBoss.actor, m2.profileId),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
    },
  );

  await t.test(
    'handing over moves every client, and their waiting requests follow the new agent',
    async () => {
      const a = await member('Hand Asif', 'male');
      const b = await member('Hand Bela', 'female');
      const c = await member('Hand Chaya', 'female');
      await clients.assign(boss.actor, b.profileId, abir.id, 'c');
      await clients.assign(boss.actor, c.profileId, abir.id, 'c');
      await release(a.profileId, b.profileId);
      const sent = await connections.send(a.actor, b.profileId, 'c');
      const waitingFor = async (who: typeof abir) =>
        (await connections.reviewQueue(who.actor, { limit: 50 })).items.some(
          (r) => r.connectionId === sent.connectionId,
        );
      assert.equal(await waitingFor(abir), true);
      assert.equal(await waitingFor(rival), false);

      const before = (await clients.listStaff(boss.actor)).find((s) => s.id === abir.id)!;
      assert.ok(before.clientCount >= 2);
      await assert.rejects(
        clients.handOver(abir.actor, abir.id, rival.id, 'c'),
        refused(403, 'ROLE_FORBIDDEN'),
      );
      await assert.rejects(
        clients.handOver(boss.actor, abir.id, abir.id, 'c'),
        refused(422, 'AGENT_NOT_AVAILABLE'),
      );
      const done = await clients.handOver(boss.actor, abir.id, rival.id, 'c');
      assert.equal(done.moved, before.clientCount);
      assert.equal(await agentOf(b.profileId), rival.id);
      assert.equal(await agentOf(c.profileId), rival.id);
      // The request that waited for Abir now waits for Rival.
      assert.equal(await waitingFor(abir), false);
      assert.equal(await waitingFor(rival), true);
      const trail = await clients.assignments(boss.actor, b.profileId);
      assert.equal(trail[0]?.reason, 'handed_over');
      assert.deepEqual([trail[0]?.from?.displayName, trail[0]?.to?.displayName], ['Abir', 'Rival']);
      // To nobody is allowed too; the clients are then in nobody's care.
      await clients.handOver(boss.actor, rival.id, null, 'c');
      assert.equal(await agentOf(b.profileId), null);
    },
  );

  await t.test(
    'a staff account is turned off and on, never your own and never the last admin',
    async () => {
      const off = await clients.setStaffStatus(boss.actor, rival.id, 'disabled', 'c');
      assert.equal(off.status, 'disabled');
      assert.equal(await status(rival.id), 'disabled');
      // A disabled person cannot be given clients.
      await assert.rejects(
        clients.assign(boss.actor, m3.profileId, rival.id, 'c'),
        refused(422, 'AGENT_NOT_AVAILABLE'),
      );
      const on = await clients.setStaffStatus(boss.actor, rival.id, 'active', 'c');
      assert.equal(on.status, 'active');

      await assert.rejects(
        clients.setStaffStatus(boss.actor, boss.id, 'disabled', 'c'),
        refused(409, 'CANNOT_DISABLE_SELF'),
      );
      // A second admin: either may be turned off by the other, but the last one stays.
      const second = await account('admin', 'Second boss');
      await clients.setStaffStatus(boss.actor, second.id, 'disabled', 'c');
      await clients.setStaffStatus(boss.actor, second.id, 'active', 'c');
      await clients.setStaffStatus(second.actor, boss.id, 'disabled', 'c');
      await assert.rejects(
        clients.setStaffStatus(second.actor, second.id, 'disabled', 'c'),
        refused(409, 'CANNOT_DISABLE_SELF'),
      );
      await clients.setStaffStatus(second.actor, boss.id, 'active', 'c');
      // Not a member, not another agency's staff, and an agent cannot do it.
      await assert.rejects(
        clients.setStaffStatus(boss.actor, m1.id, 'disabled', 'c'),
        refused(404, 'STAFF_NOT_FOUND'),
      );
      await assert.rejects(
        clients.setStaffStatus(boss.actor, foreignBoss.id, 'disabled', 'c'),
        refused(404, 'STAFF_NOT_FOUND'),
      );
      await assert.rejects(
        clients.setStaffStatus(abir.actor, rival.id, 'disabled', 'c'),
        refused(403, 'ROLE_FORBIDDEN'),
      );
      // The database only lets the application change the status of an account, nothing else.
      await assert.rejects(
        pool.query(`UPDATE matrimony.accounts SET role = 'admin' WHERE id = $1`, [rival.id]),
        /permission denied/,
      );
    },
  );

  await t.test('the nightly refresh runs once a day and proposes new members', async () => {
    const x = await member('Night Xavier', 'male');
    await member('Night Yasmin', 'female');
    // Before anything, nobody has been proposed to X.
    const proposedFor = async (id: string) =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM matrimony.client_candidates WHERE client_profile_id = $1`,
          [id],
        )
      ).rows[0].n as number;
    // The agency's other clients also get refreshed, so only X's change is checked.
    const first = await candidates.refreshNightly(agencyId);
    assert.ok(first !== null && first >= 1);
    assert.ok((await proposedFor(x.profileId)) >= 1);
    // The same day again is a no-op, whichever process asks.
    assert.equal(await candidates.refreshNightly(agencyId), null);

    // A new member joins; the next night's run proposes her, once the last run is yesterday's.
    const late = await member('Night Zeenat', 'female');
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM matrimony.client_candidates WHERE client_profile_id = $1 AND candidate_profile_id = $2`,
          [x.profileId, late.profileId],
        )
      ).rows[0].n,
      0,
    );
    await admin.query(
      `UPDATE matrimony.job_runs SET last_run_at = now() - interval '1 day' WHERE agency_id = $1`,
      [agencyId],
    );
    assert.ok((await candidates.refreshNightly(agencyId)) !== null);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM matrimony.client_candidates WHERE client_profile_id = $1 AND candidate_profile_id = $2`,
          [x.profileId, late.profileId],
        )
      ).rows[0].n,
      1,
    );
    // Another agency's run is its own: this one's claim does not stop it.
    assert.ok((await candidates.refreshNightly(elsewhereId)) !== null);
  });

  await t.test(
    'a member code is searched only when staff switch it on for that client',
    async () => {
      const p = await member('Code Peter', 'male');
      const q = await member('Code Qadira', 'female');
      await release(p.profileId, q.profileId);
      const find = (code: string) =>
        matches.page(p.actor, matchQuerySchema.parse({ q: code, limit: 20 }));
      const settings = await candidates.settings(boss.actor, p.profileId);
      assert.equal(settings.allowCodeSearch, false);
      const code = (
        await admin.query(`SELECT member_code FROM matrimony.member_profiles WHERE id = $1`, [
          q.profileId,
        ])
      ).rows[0].member_code as string;

      await assert.rejects(find(code), refused(400, 'FILTER_NOT_AVAILABLE'));
      assert.equal(
        (await matches.page(p.actor, matchQuerySchema.parse({ limit: 20 }))).canSearchByCode,
        false,
      );

      const saved = await candidates.saveSettings(
        boss.actor,
        p.profileId,
        { cap: 50, visibleFields: ['fullName', 'age'], allowCodeSearch: true },
        'c',
      );
      assert.equal(saved.allowCodeSearch, true);
      const page = await find(code);
      assert.equal(page.canSearchByCode, true);
      assert.deepEqual(
        page.items.map((i) => i.memberCode),
        [code],
      );
      // It still only finds people in the client's own window, never anyone else in the agency.
      const outside = (
        await admin.query(`SELECT member_code FROM matrimony.member_profiles WHERE id = $1`, [
          m3.profileId,
        ])
      ).rows[0].member_code as string;
      assert.deepEqual((await find(outside)).items, []);
    },
  );
  const inbox = (actor: ProfileActor) =>
    connections.notifications(actor, notificationQuerySchema.parse({ limit: 50 }));

  await t.test('a client who signs in is told when profiles are released to them', async () => {
    const a = await member('Rel Rafiq', 'male');
    const b = await member('Rel Rina', 'female');
    await release(a.profileId, b.profileId);
    const told = (await inbox(a.actor)).items.filter((n) => n.kind === 'candidates_released');
    assert.equal(told.length, 1);
    assert.equal(told[0]!.count, 1);
    assert.equal(told[0]!.forProfileId, a.profileId);
    assert.equal(told[0]!.connectionId, null);
    // The other person is not told anything by that.
    assert.equal(
      (await inbox(b.actor)).items.some((n) => n.kind === 'candidates_released'),
      false,
    );
    assert.ok((await connections.unreadCount(a.actor)) >= 1);
  });

  await t.test(
    'whoever reviews is told when a profile is sent, and the sender is not',
    async () => {
      const fresh = await account('member', 'Review Rumana');
      const saved = await profiles.save(
        fresh.actor,
        profileInputSchema(NOW).parse({
          profile: { fullName: 'Review Rumana', ...BASE, gender: 'female' },
          contact: { phone: '+8801711111111' },
        }),
      );
      // Registering gave the profile an agent already.
      const agent = await agentOf(saved.profile!.id);
      assert.ok(agent === abir.id || agent === rival.id);
      const sent = await profiles.submit(fresh.actor, saved.profile!.version, 'c');
      const asked = async (who: { actor: ProfileActor }) =>
        (await inbox(who.actor)).items.filter(
          (n) => n.kind === 'review_requested' && n.forProfileId === saved.profile!.id,
        );
      const bossLines = await asked(boss);
      assert.equal(bossLines.length, 1);
      assert.equal(bossLines[0]!.what, 'profile');
      // The agent who looks after the profile is told; the other agent and the sender are not.
      const mine = agent === abir.id ? abir : rival;
      const other = agent === abir.id ? rival : abir;
      assert.equal((await asked(mine)).length, 1);
      assert.equal((await asked(other)).length, 0);
      assert.equal((await asked(fresh)).length, 0);

      // A change to the approved profile is announced as a change.
      await reviews.approve(boss.actor, sent.pendingReview!.id, {}, 'c');
      const state = await profiles.get(fresh.actor);
      const next = profileInputSchema(NOW).parse({
        profile: { fullName: 'Review Rumana Khan', ...BASE, gender: 'female' },
        contact: { phone: '+8801711111111' },
      });
      await profiles.requestEdit(
        fresh.actor,
        { ...next, version: state.profile!.version } as never,
        'c',
      );
      const edits = (await asked(boss)).filter((n) => n.what === 'edit');
      assert.equal(edits.length, 1);
    },
  );

  await t.test(
    'every new client is given to the agent with the fewest, and the agent is told',
    async () => {
      const tally = async () =>
        (await clients.listStaff(boss.actor))
          .filter((s) => s.role === 'agent' && s.status === 'active')
          .map((s) => ({ id: s.id, n: s.clientCount }));
      const before = await tally();
      const fewest = [...before].sort((a, b) => a.n - b.n)[0]!;
      const next = await member('Auto Anwar', 'male');
      assert.equal(await agentOf(next.profileId), fewest.id);

      const trail = await clients.assignments(boss.actor, next.profileId);
      assert.equal(trail.length, 1);
      assert.equal(trail[0]!.reason, 'automatic');
      assert.equal(trail[0]!.by, null);
      assert.equal(trail[0]!.from, null);

      const asAgent = fewest.id === abir.id ? abir : rival;
      const told = (await inbox(asAgent.actor)).items.filter(
        (n) => n.kind === 'client_assigned' && n.forProfileId === next.profileId,
      );
      assert.equal(told.length, 1);

      // A client staff add without choosing an agent gets one; with one chosen, that is kept.
      const addClient = async (name: string, agentId: string | null) =>
        (
          await clients.create(
            boss.actor,
            clientInputSchema(NOW).parse({
              profile: { fullName: name, ...BASE, gender: 'female' },
              contact: { contactName: 'Agency desk', phone: '+8801722222222' },
              assignedAgentId: agentId,
            }),
            'c',
          )
        ).id;
      const nobody = await addClient('Auto Nobody', null);
      const given = await agentOf(nobody);
      assert.ok(given === abir.id || given === rival.id);
      const chosen = await addClient('Auto Chosen', rival.id);
      assert.equal(await agentOf(chosen), rival.id);
      assert.equal((await clients.assignments(boss.actor, chosen)).length, 0);

      // An agency with no active agent leaves it unassigned, and nothing fails.
      const lonely = await member('Auto Lonely', 'male', elsewhereId);
      assert.equal(await agentOf(lonely.profileId), null);
    },
  );

  await t.test(
    'an admin creates a staff account directly, and never over an existing address',
    async () => {
      const staffService = new StaffInvitationService(
        new StaffInvitationDbService(
          db,
          new StaffInvitationRepository(),
          new RegistrationRepository(),
          new EventRepository(),
        ),
      );
      const asAdmin = { agencyId, accountId: boss.id, role: 'admin' as const };
      const made = await staffService.createDirect(
        asAdmin,
        {
          email: `direct-${tag}@example.com`,
          displayName: 'Direct Dina',
          role: 'agent',
          locale: 'bn',
        },
        await new PasswordHasher().hash('Direct-Strong-Pass-1'),
        'c',
      );
      assert.equal(made.role, 'agent');
      const row = (
        await admin.query(
          `SELECT a.status, a.email_verified_at IS NOT NULL AS verified
           FROM matrimony.accounts a WHERE a.id = $1`,
          [made.id],
        )
      ).rows[0];
      assert.deepEqual([row.status, row.verified], ['active', true]);
      // She is staff now: she appears in the list and can be given clients.
      const listed = (await clients.listStaff(boss.actor)).find((s) => s.id === made.id);
      assert.equal(listed?.status, 'active');
      await clients.assign(boss.actor, m3.profileId, made.id, 'c');

      // The same address again, and a member's address, are refused. A member is never made staff.
      await assert.rejects(
        staffService.createDirect(
          asAdmin,
          { email: `direct-${tag}@example.com`, displayName: 'Again', role: 'admin', locale: 'en' },
          'hash',
          'c',
        ),
        refused(409, 'EMAIL_IN_USE'),
      );
      const memberEmail = (
        await admin.query(`SELECT email FROM matrimony.accounts WHERE id = $1`, [m1.id])
      ).rows[0].email as string;
      await assert.rejects(
        staffService.createDirect(
          asAdmin,
          { email: memberEmail, displayName: 'Takeover', role: 'admin', locale: 'en' },
          'hash',
          'c',
        ),
        refused(409, 'EMAIL_IN_USE'),
      );
      await assert.rejects(
        staffService.createDirect(
          { ...asAdmin, role: 'agent' },
          { email: `x-${tag}@example.com`, displayName: 'X', role: 'agent', locale: 'en' },
          'hash',
          'c',
        ),
        refused(403, 'ROLE_FORBIDDEN'),
      );
    },
  );

  await t.test(
    'the database tells the listening process when a line is added, and only for that account',
    async () => {
      const hub = new NotificationHub(listenClientFor(runtimeUrl.href), pino({ level: 'silent' }));
      await hub.start();
      t.after(() => hub.stop());
      const a = await member('Live Lamia', 'male');
      const b = await member('Live Lubna', 'female');
      await release(a.profileId, b.profileId);
      // Releasing told A (a line for them), which arrives as a signal; let it pass before listening.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const heard: string[] = [];
      const stopA = hub.subscribe(agencyId, a.id, () => heard.push('a'))!;
      const stopB = hub.subscribe(agencyId, b.id, () => heard.push('b'))!;
      // A asks B: B's agent is told (not B), so neither A nor B hears anything yet.
      const sent = await connections.send(a.actor, b.profileId, 'c');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(heard, []);
      // Approving tells B (the request) and A (it went through), and nobody else.
      await connections.review(boss.actor, sent.connectionId, true, 'c');
      for (let i = 0; i < 40 && heard.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.deepEqual([...heard].sort(), ['a', 'b']);
      stopA();
      stopB();
    },
  );
});
