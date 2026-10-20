import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { clientInputSchema } from '../../src/bo/client.js';
import { connectionListQuerySchema, notificationQuerySchema } from '../../src/bo/connection.js';
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
const inbox = (limit = 20, after?: string) => notificationQuerySchema.parse({ limit, after });
const box = (name: 'received' | 'sent' | 'connected') =>
  connectionListQuerySchema.parse({ box: name });

await test('connection requests and the inbox on real PostgreSQL', async (t) => {
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
      `con-${tag}`,
      `con-${tag}.localhost`,
      elsewhereId,
      `con2-${tag}`,
      `con2-${tag}.localhost`,
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
  /** A client the agency runs, with an agent, published. */
  const assisted = async (name: string, gender: 'male' | 'female', agent: typeof abir | null) => {
    const created = await clients.create(
      boss.actor,
      clientInputSchema(NOW).parse({
        profile: { fullName: name, ...BASE, gender },
        contact: {
          contactName: 'Agency desk',
          phone: '+8801722222222',
          permanentAddress: 'SECRET ADDRESS of client',
        },
        assignedAgentId: agent?.id ?? null,
      }),
      'c',
    );
    const sent = await clients.submit(
      boss.actor,
      created.id,
      created.detail.state.profile!.version,
      'c',
    );
    await reviews.approve(boss.actor, sent.state.pendingReview!.id, {}, 'c');
    return created.id;
  };
  /** Puts `other` in `of`'s released window. */
  const release = async (of: string, other: string) => {
    await candidates.generate(boss.actor, of);
    await candidates.release(boss.actor, of, { candidateIds: [other] }, 'c');
  };
  const connectionRows = async (a: string, b: string) =>
    (
      await admin.query(
        `SELECT status, sender_profile_id AS from_profile_id, recipient_profile_id AS to_profile_id, (sender_contact_consent_at IS NOT NULL) AS from_shared_contact, (recipient_contact_consent_at IS NOT NULL) AS to_shared_contact FROM matrimony.interests
          WHERE agency_id = $1 AND ((sender_profile_id = $2 AND recipient_profile_id = $3) OR (sender_profile_id = $3 AND recipient_profile_id = $2))`,
        [agencyId, a, b],
      )
    ).rows;

  // The inbox also holds lines that are not about connections (releases, review requests). These
  // tests are about connections, so they look at those lines only.
  const interestLines = async (actor: ProfileActor, query: ReturnType<typeof inbox>) => {
    const page = await connections.notifications(actor, query);
    // (The asker's "your request went through" line is checked on its own, in the review test.)
    return {
      ...page,
      items: page.items.filter(
        (n) => n.kind.startsWith('connection_') && n.kind !== 'connection_forwarded',
      ),
    };
  };
  const m1 = await member('Mahir One', 'male');
  const m2 = await member('Nila Two', 'female');
  const z = await assisted('Zara Client', 'female', abir);
  const orphan = await assisted('Olive Client', 'female', null);
  // A request now waits for review. Most of what these tests check begins once an admin has approved it,
  // so `ask` sends the request and approves it; the review itself is tested on its own further down.
  const ask = async (actor: ProfileActor, to: string) => {
    const sent = await connections.send(actor, to, 'c');
    if (sent.outcome === 'requested' && sent.status === 'in_review') {
      await connections.review(boss.actor, sent.connectionId, true, 'c');
      return { ...sent, status: 'pending' as const };
    }
    return sent;
  };
  await release(m1.profileId, m2.profileId);
  await release(m1.profileId, z);
  await release(m1.profileId, orphan);
  // M2's window does not hold M1: a request will be what lets M2 look at M1.

  await t.test('a request is stored once and tells the person asked, by name', async () => {
    // Both were told their profile was approved when they were set up: read those first, so that
    // only this request counts below.
    await connections.markRead(m1.actor, null);
    await connections.markRead(m2.actor, null);
    const sent = await ask(m1.actor, m2.profileId);
    assert.equal(sent.outcome, 'requested');
    const again = await ask(m1.actor, m2.profileId);
    assert.deepEqual([again.outcome, again.connectionId], ['unchanged', sent.connectionId]);
    assert.equal((await connectionRows(m1.profileId, m2.profileId)).length, 1);

    const told = await interestLines(m2.actor, inbox());
    assert.equal(told.items.length, 1);
    assert.equal(told.items[0]!.kind, 'connection_request');
    assert.equal(told.items[0]!.about?.fullName, 'Mahir One');
    assert.equal(told.items[0]!.forProfileId, m2.profileId);
    // The one who asked is not told about their own request.
    assert.deepEqual((await interestLines(m1.actor, inbox())).items, []);

    // The line is unread until its recipient reads it, and nobody else can read it for them.
    assert.equal(told.items[0]!.read, false);
    // M1 has the lines about profiles released to them; they are read first, so only this request counts.
    await connections.markRead(m1.actor, null);
    assert.equal(await connections.unreadCount(m2.actor), 1);
    assert.equal(await connections.unreadCount(m1.actor), 0);
    await connections.markRead(m1.actor, [told.items[0]!.id]);
    assert.equal(await connections.unreadCount(m2.actor), 1);
    await connections.markRead(m2.actor, [told.items[0]!.id]);
    assert.equal(await connections.unreadCount(m2.actor), 0);
    assert.equal((await interestLines(m2.actor, inbox())).items[0]!.read, true);
    // Reading again, or reading everything, changes nothing.
    await connections.markRead(m2.actor, null);
    assert.equal(await connections.unreadCount(m2.actor), 0);
  });

  await t.test(
    'the person asked sees who asked, and the asker sees the request waiting',
    async () => {
      const received = await connections.list(m2.actor, box('received'));
      assert.deepEqual(
        received.items.map((i) => [i.profile.fullName, i.status, i.direction]),
        [['Mahir One', 'pending', 'received']],
      );
      const sentList = await connections.list(m1.actor, box('sent'));
      assert.deepEqual(
        sentList.items.map((i) => [i.profile.fullName, i.status, i.direction]),
        [['Nila Two', 'pending', 'sent']],
      );
      assert.deepEqual((await connections.list(m1.actor, box('connected'))).items, []);
      // Nobody else sees it.
      assert.deepEqual(
        (await connections.list(await (await member('Third Man', 'male')).actor, box('received')))
          .items,
        [],
      );
    },
  );

  await t.test(
    'a request lets the person asked look at the asker, though they were never released to them',
    async () => {
      const detail = await matches.detail(m2.actor, m1.profileId);
      assert.equal(detail.profile.fullName, 'Mahir One');
      assert.deepEqual(
        [detail.connection?.status, detail.connection?.direction],
        ['pending', 'received'],
      );
      assert.equal(detail.contact, null);
      // An unrelated profile is still not theirs to look at.
      const stranger = await member('Stranger', 'male');
      await assert.rejects(
        matches.detail(m2.actor, stranger.profileId),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
    },
  );

  await t.test('only the person asked answers; an acceptance tells both', async () => {
    const id = (await connections.list(m2.actor, box('received'))).items[0]!.connectionId;
    await assert.rejects(
      connections.respond(m1.actor, id, true, 'c'),
      refused(404, 'CONNECTION_NOT_FOUND'),
    );
    await connections.respond(m2.actor, id, true, 'c');
    await assert.rejects(
      connections.respond(m2.actor, id, false, 'c'),
      refused(409, 'CONNECTION_NOT_PENDING'),
    );
    assert.equal((await connectionRows(m1.profileId, m2.profileId))[0].status, 'accepted');
    assert.deepEqual(
      (await interestLines(m1.actor, inbox())).items.map((n) => n.kind),
      ['connection_accepted'],
    );
    const second = await interestLines(m2.actor, inbox());
    assert.deepEqual(
      second.items.map((n) => n.kind),
      ['connection_accepted', 'connection_request'],
    );
    assert.equal((await connections.list(m1.actor, box('connected'))).items.length, 1);
    assert.equal((await connections.list(m2.actor, box('connected'))).items.length, 1);
  });

  await t.test(
    'a line about a staff account that joined shows, though it is not about a profile',
    async () => {
      await admin.query(
        `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       VALUES ($1, $2, $3, 'staff.joined', $4::jsonb)`,
        [
          agencyId,
          boss.actor.accountId,
          `staff-joined:${randomUUID()}`,
          JSON.stringify({ staffAccountId: randomUUID(), name: 'New Agent', role: 'agent' }),
        ],
      );
      const page = await connections.notifications(boss.actor, inbox());
      const line = page.items.find((n) => n.kind === 'staff_joined');
      assert.deepEqual(
        [line?.staff, line?.about, line?.forProfileId],
        [{ name: 'New Agent', role: 'agent' }, null, null],
      );
    },
  );

  await t.test('the inbox pages without gaps or repeats, newest first', async () => {
    const first = await interestLines(m2.actor, inbox(1));
    assert.equal(first.items.length, 1);
    assert.ok(first.next);
    const second = await interestLines(m2.actor, inbox(1, first.next!));
    assert.deepEqual(
      [first.items[0]!.kind, second.items[0]!.kind],
      ['connection_accepted', 'connection_request'],
    );
    // Older lines (such as "your profile was approved") follow; walking to the end repeats none.
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await connections.notifications(m2.actor, inbox(1, after));
      seen.push(...page.items.map((n) => n.id));
      after = page.next ?? undefined;
    } while (after);
    assert.equal(new Set(seen).size, seen.length);
  });

  await t.test(
    'contact stays private until the other person shares it, and the address never leaves',
    async () => {
      const connectionId = (await connections.list(m1.actor, box('connected'))).items[0]!
        .connectionId;
      assert.equal((await matches.detail(m1.actor, m2.profileId)).contact, null);
      assert.equal((await matches.detail(m2.actor, m1.profileId)).contact, null);

      // M1 shares: M2 can now see M1's contact, but M1 still cannot see M2's.
      await connections.shareContact(m1.actor, connectionId, 'c');
      const seenByM2 = await matches.detail(m2.actor, m1.profileId);
      assert.deepEqual(seenByM2.contact, {
        name: 'Mahir One contact',
        relationship: 'self',
        phone: '+8801711111111',
        email: 'mahirone@example.com',
      });
      assert.equal(seenByM2.connection?.theyShared, true);
      assert.equal(seenByM2.connection?.iShared, false);
      assert.equal((await matches.detail(m1.actor, m2.profileId)).contact, null);
      assert.equal(JSON.stringify(seenByM2).includes('SECRET'), false);

      await connections.shareContact(m2.actor, connectionId, 'c');
      const seenByM1 = await matches.detail(m1.actor, m2.profileId);
      assert.equal(seenByM1.contact?.phone, '+8801711111111');
      assert.equal(JSON.stringify(seenByM1).includes('SECRET'), false);
    },
  );

  await t.test('the database refuses contact shared outside an accepted connection', async () => {
    const m3 = await member('Pending Pat', 'male');
    const m4 = await member('Pending Pia', 'female');
    await release(m3.profileId, m4.profileId);
    await ask(m3.actor, m4.profileId);
    await assert.rejects(
      admin.query(
        `UPDATE matrimony.interests SET sender_contact_consent_at = now() WHERE agency_id = $1 AND sender_profile_id = $2`,
        [agencyId, m3.profileId],
      ),
      /interests_contact_only_when_accepted|check constraint/,
    );
  });

  await t.test('a declined pair stays declined for both, and is not asked again', async () => {
    const a = await member('Decline Dan', 'male');
    const b = await member('Decline Dee', 'female');
    await release(a.profileId, b.profileId);
    await release(b.profileId, a.profileId);
    const { connectionId } = await ask(a.actor, b.profileId);
    await connections.respond(b.actor, connectionId, false, 'c');
    assert.deepEqual(
      (await interestLines(a.actor, inbox())).items.map((n) => n.kind),
      ['connection_declined'],
    );
    assert.deepEqual(
      (await interestLines(b.actor, inbox())).items.map((n) => n.kind),
      ['connection_request'],
    );
    await assert.rejects(ask(a.actor, b.profileId), refused(409, 'CONNECTION_DECLINED'));
    await assert.rejects(ask(b.actor, a.profileId), refused(409, 'CONNECTION_DECLINED'));
    assert.equal((await connectionRows(a.profileId, b.profileId)).length, 1);
  });

  await t.test(
    'a withdrawn request can be asked again, by either side, on the same row',
    async () => {
      const a = await member('Withdraw Wes', 'male');
      const b = await member('Withdraw Win', 'female');
      await release(a.profileId, b.profileId);
      await release(b.profileId, a.profileId);
      const first = await ask(a.actor, b.profileId);
      await assert.rejects(
        connections.withdraw(b.actor, first.connectionId, 'c'),
        refused(404, 'CONNECTION_NOT_FOUND'),
      );
      await connections.withdraw(a.actor, first.connectionId, 'c');
      await assert.rejects(
        connections.respond(b.actor, first.connectionId, true, 'c'),
        refused(409, 'CONNECTION_NOT_PENDING'),
      );
      const again = await ask(b.actor, a.profileId);
      assert.deepEqual([again.outcome, again.connectionId], ['requested', first.connectionId]);
      const [row] = await connectionRows(a.profileId, b.profileId);
      assert.equal(row.from_profile_id, b.profileId);
      assert.equal(row.status, 'pending');
    },
  );

  await t.test(
    'two people asking each other at the same moment end as one accepted pair, never a deadlock',
    async () => {
      for (let round = 0; round < 6; round += 1) {
        const a = await member(`Race A${round}`, 'male');
        const b = await member(`Race B${round}`, 'female');
        await release(a.profileId, b.profileId);
        await release(b.profileId, a.profileId);
        const results = await Promise.all([
          connections.send(a.actor, b.profileId, 'c'),
          connections.send(b.actor, a.profileId, 'c'),
        ]);
        // One row, whoever won: the other side's ask finds the request already there.
        const rows = await connectionRows(a.profileId, b.profileId);
        assert.equal(rows.length, 1, `round ${round}`);
        assert.equal(results[0]!.connectionId, results[1]!.connectionId);
        assert.deepEqual(results.map((r) => r.outcome).sort(), ['requested', 'unchanged']);
        // Once approved, the other side asking is what makes it one accepted connection.
        const second = rows[0].from_profile_id === a.profileId ? b : a;
        assert.equal(rows[0].status, 'in_review', `round ${round}`);
        await connections.review(boss.actor, results[0]!.connectionId, true, 'c');
        assert.equal((await connectionRows(a.profileId, b.profileId))[0].status, 'pending');
        assert.equal((await ask(second.actor, rows[0].from_profile_id)).outcome, 'accepted');
        assert.equal((await connectionRows(a.profileId, b.profileId))[0].status, 'accepted');
      }
    },
  );

  await t.test(
    'a request waits for the agent first: the person asked is told nothing, sees nothing and cannot answer',
    async () => {
      const a = await member('Review Rafi', 'male');
      const b = await member('Review Rima', 'female');
      await release(a.profileId, b.profileId);
      await admin.query(
        `UPDATE matrimony.member_profiles SET assigned_agent_id = $3 WHERE agency_id = $1 AND id = $2`,
        [agencyId, b.profileId, abir.id],
      );
      const sent = await connections.send(
        a.actor,
        b.profileId,
        'c',
        'Our families know each other',
      );
      assert.deepEqual([sent.outcome, sent.status], ['requested', 'in_review']);

      // The person asked: nothing in the inbox, nothing in the lists, no way to open the profile or answer.
      assert.deepEqual((await interestLines(b.actor, inbox())).items, []);
      assert.deepEqual((await connections.list(b.actor, box('received'))).items, []);
      await assert.rejects(matches.detail(b.actor, a.profileId), refused(404, 'PROFILE_NOT_FOUND'));
      await assert.rejects(
        connections.respond(b.actor, sent.connectionId, true, 'c'),
        refused(409, 'CONNECTION_NOT_PENDING'),
      );
      // The asker sees it waiting; the agent is told and sees it in their queue with the note.
      const mine = await connections.list(a.actor, box('sent'));
      assert.deepEqual(
        mine.items.filter((i) => i.profile.candidateId === b.profileId).map((i) => i.status),
        ['in_review'],
      );
      const told = await interestLines(abir.actor, inbox());
      assert.equal(told.items[0]!.kind, 'connection_review');
      assert.equal(told.items[0]!.forProfileId, b.profileId);
      const queue = await connections.reviewQueue(abir.actor, { limit: 20 });
      const waiting = queue.items.find((r) => r.connectionId === sent.connectionId)!;
      assert.equal(waiting.note, 'Our families know each other');
      assert.equal(waiting.client.profileId, b.profileId);
      // Another agent sees none of it; an admin sees it.
      assert.equal(
        (await connections.reviewQueue(rival.actor, { limit: 20 })).items.some(
          (r) => r.connectionId === sent.connectionId,
        ),
        false,
      );
      assert.ok(
        (await connections.reviewQueue(boss.actor, { limit: 50 })).items.some(
          (r) => r.connectionId === sent.connectionId,
        ),
      );
      await assert.rejects(
        connections.review(rival.actor, sent.connectionId, true, 'c'),
        refused(404, 'CONNECTION_NOT_FOUND'),
      );

      // Approved: the person asked is told, sees the asker and the note, and can answer.
      await connections.review(abir.actor, sent.connectionId, true, 'c');
      const inboxB = await interestLines(b.actor, inbox());
      assert.deepEqual(
        inboxB.items.map((n) => n.kind),
        ['connection_request'],
      );
      const received = (await connections.list(b.actor, box('received'))).items;
      assert.equal(received[0]!.note, 'Our families know each other');
      assert.equal((await matches.detail(b.actor, a.profileId)).connection?.direction, 'received');
      await connections.respond(b.actor, sent.connectionId, true, 'c');
      assert.equal((await connectionRows(a.profileId, b.profileId))[0].status, 'accepted');
      // The note is for the person asked to see, not for the asker's own list.
      assert.equal((await connections.list(a.actor, box('connected'))).items[0]!.note, null);
    },
  );

  await t.test(
    'rejecting ends it as declined for the asker, withdrawing works while waiting, and staff can reopen',
    async () => {
      const a = await member('Reject Ruhi', 'male');
      const b = await member('Reject Rina', 'female');
      await release(a.profileId, b.profileId);
      const first = await connections.send(a.actor, b.profileId, 'c');
      await connections.review(boss.actor, first.connectionId, false, 'c');
      assert.equal((await connectionRows(a.profileId, b.profileId))[0].status, 'declined');
      assert.equal((await interestLines(a.actor, inbox())).items[0]!.kind, 'connection_declined');
      await assert.rejects(
        connections.send(a.actor, b.profileId, 'c'),
        refused(409, 'CONNECTION_DECLINED'),
      );
      await assert.rejects(
        connections.review(boss.actor, first.connectionId, true, 'c'),
        refused(409, 'CONNECTION_NOT_IN_REVIEW'),
      );

      // Staff reopen it, and then it can be asked again; a member cannot reopen.
      await assert.rejects(
        connections.reopen(a.actor, first.connectionId, 'c'),
        refused(403, 'ROLE_FORBIDDEN'),
      );
      await connections.reopen(boss.actor, first.connectionId, 'c');
      assert.equal((await connectionRows(a.profileId, b.profileId))[0].status, 'withdrawn');
      const again = await connections.send(a.actor, b.profileId, 'c');
      assert.deepEqual([again.outcome, again.status], ['requested', 'in_review']);
      await assert.rejects(
        connections.reopen(boss.actor, first.connectionId, 'c'),
        refused(409, 'CONNECTION_NOT_DECLINED'),
      );

      // Taken back while waiting, it can no longer be reviewed.
      await connections.withdraw(a.actor, again.connectionId, 'c');
      assert.equal((await connectionRows(a.profileId, b.profileId))[0].status, 'withdrawn');
      await assert.rejects(
        connections.review(boss.actor, again.connectionId, true, 'c'),
        refused(409, 'CONNECTION_NOT_IN_REVIEW'),
      );
    },
  );

  await t.test(
    'reminders: the agent after 2 days, then every 3, and the admins too from the third',
    async () => {
      const a = await member('Remind Raju', 'male');
      const b = await member('Remind Rani', 'female');
      await release(a.profileId, b.profileId);
      await admin.query(
        `UPDATE matrimony.member_profiles SET assigned_agent_id = $3 WHERE agency_id = $1 AND id = $2`,
        [agencyId, b.profileId, abir.id],
      );
      const sent = await connections.send(a.actor, b.profileId, 'c');
      const reminders = async (who: ProfileActor) =>
        (await interestLines(who, inbox(50))).items.filter(
          (n) => n.kind === 'connection_review_reminder' && n.forProfileId === b.profileId,
        ).length;
      // Makes the request look as if it started waiting, and was last reminded, `days` days ago.
      const age = (days: number) =>
        admin.query(
          `UPDATE matrimony.interests SET review_started_at = now() - make_interval(days => $3::int, mins => 1),
                  last_reminded_at = CASE WHEN reminders_sent > 0 THEN now() - make_interval(days => $3::int, mins => 1) END
            WHERE agency_id = $1 AND id = $2`,
          [agencyId, sent.connectionId, days],
        );
      // Runs the job and says how many reminders this request's agent gained.
      const run = async () => {
        const before = await reminders(abir.actor);
        await connections.remindStale(agencyId, 'job');
        return (await reminders(abir.actor)) - before;
      };

      // One day in: nothing. Two days in: the first reminder, to the agent.
      await age(1);
      assert.equal(await run(), 0);
      await age(2);
      assert.equal(await run(), 1);
      assert.equal(await reminders(boss.actor), 0);
      // Not again at once, nor before 3 days have passed since the last one.
      assert.equal(await run(), 0);
      await age(2);
      assert.equal(await run(), 0);
      await age(3);
      assert.equal(await run(), 1);
      assert.equal(await reminders(boss.actor), 0);
      // The third reminder goes to the admins as well.
      await age(3);
      assert.equal(await run(), 1);
      assert.equal(await reminders(boss.actor), 1);
      const row = (
        await admin.query(
          `SELECT reminders_sent FROM matrimony.interests WHERE agency_id = $1 AND id = $2`,
          [agencyId, sent.connectionId],
        )
      ).rows[0];
      assert.equal(row.reminders_sent, 3);
      // Once approved, there is nothing left to remind about.
      await connections.review(abir.actor, sent.connectionId, true, 'c');
      await age(10);
      assert.equal(await run(), 0);
    },
  );

  await t.test(
    'a profile that matches leaves the windows, its waiting requests are withdrawn and the senders told',
    async () => {
      const a = await member('Match Asif', 'male');
      const c = await member('Match Chaiti', 'male');
      const b = await member('Match Bina', 'female');
      await release(a.profileId, b.profileId);
      await release(c.profileId, b.profileId);
      await release(b.profileId, a.profileId);
      // One request still in review, one approved and waiting for her, and one she sent herself.
      const first = await connections.send(a.actor, b.profileId, 'c');
      const second = await ask(c.actor, b.profileId);
      const f = await member('Match Farhan', 'male');
      await release(b.profileId, f.profileId);
      const hers = await ask(b.actor, f.profileId);
      assert.equal(first.status, 'in_review');
      assert.equal(second.status, 'pending');
      assert.equal(hers.status, 'pending');

      const status = async (id: string) =>
        (
          await admin.query(`SELECT status, version FROM matrimony.member_profiles WHERE id = $1`, [
            id,
          ])
        ).rows[0];
      const before = await status(b.profileId);
      await clients.changeStatus(boss.actor, b.profileId, 'matched', before.version, 'c');

      // Everything waiting to or from her is withdrawn, and the people who asked her are told why.
      for (const x of [a, c]) {
        assert.equal((await connectionRows(x.profileId, b.profileId))[0].status, 'withdrawn');
        const told = (await interestLines(x.actor, inbox(50))).items.filter(
          (n) => n.about?.profileId === b.profileId && n.kind === 'connection_matched',
        );
        assert.equal(told.length, 1);
        assert.equal(told[0]!.forProfileId, x.profileId);
        // She is gone from their windows and lists, and her profile can no longer be opened.
        assert.equal(
          (await matches.page(x.actor, matchQuerySchema.parse({ limit: 50 }))).items.some(
            (i) => i.candidateId === b.profileId,
          ),
          false,
        );
        await assert.rejects(
          matches.detail(x.actor, b.profileId),
          refused(404, 'PROFILE_NOT_FOUND'),
        );
        await assert.rejects(ask(x.actor, b.profileId), refused(404, 'PROFILE_NOT_FOUND'));
      }
      // The one she had sent is withdrawn too, and nobody is told that she matched.
      assert.equal((await connectionRows(b.profileId, f.profileId))[0].status, 'withdrawn');
      assert.equal(
        (await interestLines(f.actor, inbox(50))).items.some(
          (n) => n.kind === 'connection_matched' || n.kind === 'connection_unavailable',
        ),
        false,
      );
      // The review queue no longer holds the request that was waiting.
      assert.equal(
        (await connections.reviewQueue(boss.actor, { limit: 50 })).items.some(
          (r) => r.connectionId === first.connectionId,
        ),
        false,
      );

      // Paused says she is not available, not that she matched. Coming back does not revive requests.
      const d = await member('Pause Dilip', 'male');
      const e = await member('Pause Elora', 'female');
      await release(d.profileId, e.profileId);
      await ask(d.actor, e.profileId);
      await clients.changeStatus(
        boss.actor,
        e.profileId,
        'paused',
        (await status(e.profileId)).version,
        'c',
      );
      const paused = (await interestLines(d.actor, inbox(50))).items.filter(
        (n) => n.about?.profileId === e.profileId,
      );
      assert.deepEqual(
        paused.map((n) => n.kind),
        ['connection_unavailable'],
      );
      assert.equal((await connectionRows(d.profileId, e.profileId))[0].status, 'withdrawn');
      await clients.changeStatus(
        boss.actor,
        e.profileId,
        'active',
        (await status(e.profileId)).version,
        'c',
      );
      assert.equal((await connectionRows(d.profileId, e.profileId))[0].status, 'withdrawn');
      // Asking again works, on the same row.
      assert.equal((await ask(d.actor, e.profileId)).outcome, 'requested');
    },
  );

  await t.test(
    'only someone in the window can be asked, and anything else is simply not found',
    async () => {
      const outsider = await member('Outside Ola', 'female');
      await assert.rejects(ask(m1.actor, outsider.profileId), refused(404, 'PROFILE_NOT_FOUND'));
      await assert.rejects(ask(m1.actor, randomUUID()), refused(404, 'PROFILE_NOT_FOUND'));
      await assert.rejects(ask(m1.actor, m1.profileId), refused(404, 'PROFILE_NOT_FOUND'));
      // A profile in another agency does not exist here at all.
      const foreign = await member('Foreign Fay', 'female', elsewhereId);
      await assert.rejects(ask(m1.actor, foreign.profileId), refused(404, 'PROFILE_NOT_FOUND'));
      // Staff and members who run nothing cannot ask.
      await assert.rejects(ask(abir.actor, m2.profileId), refused(403, 'ROLE_FORBIDDEN'));
      assert.equal((await connectionRows(m1.profileId, outsider.profileId)).length, 0);
    },
  );

  await t.test(
    'staff answer for a client who has a login too; the first answer counts',
    async () => {
      const x = await member('Own Ozzy', 'male');
      const y = await member('Own Yara', 'female');
      await release(x.profileId, y.profileId);
      const { connectionId } = await ask(x.actor, y.profileId);
      await connections.staffRespond(boss.actor, y.profileId, connectionId, true, 'c');
      assert.equal((await connectionRows(x.profileId, y.profileId))[0].status, 'accepted');
      // The client's own answer comes too late: the request is no longer waiting.
      await assert.rejects(connections.respond(y.actor, connectionId, true, 'c'));
    },
  );

  await t.test(
    'a client with no login: the agent who looks after them is told, and answers for them',
    async () => {
      const { connectionId } = await ask(m1.actor, z);
      const told = (await interestLines(abir.actor, inbox(50))).items.filter(
        (n) => n.forProfileId === z,
      );
      assert.equal(told.length, 1);
      assert.equal(told[0]!.kind, 'connection_request');
      assert.equal(told[0]!.about?.fullName, 'Mahir One');
      // Not the rival, not a member; and not the other agency.
      assert.deepEqual(
        (await interestLines(rival.actor, inbox(50))).items.filter((n) => n.forProfileId === z),
        [],
      );

      const listed = await connections.staffList(abir.actor, z);
      assert.deepEqual(
        listed.map((r) => [r.other.fullName, r.status, r.direction, r.other.serviceMode]),
        [['Mahir One', 'pending', 'received', 'self_service']],
      );
      await assert.rejects(
        connections.staffList(rival.actor, z),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        connections.staffRespond(rival.actor, z, connectionId, true, 'c'),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        connections.staffRespond(abir.actor, z, randomUUID(), true, 'c'),
        refused(404, 'CONNECTION_NOT_FOUND'),
      );

      await connections.staffRespond(abir.actor, z, connectionId, true, 'c');
      assert.equal((await connectionRows(m1.profileId, z))[0].status, 'accepted');
      assert.ok(
        (await interestLines(m1.actor, inbox())).items.some(
          (n) => n.kind === 'connection_accepted' && n.about?.profileId === z,
        ),
      );

      // Her contact is shared only when staff share it for her; the address never is.
      assert.equal((await matches.detail(m1.actor, z)).contact, null);
      await connections.staffShareContact(abir.actor, z, connectionId, 'c');
      const contact = (await matches.detail(m1.actor, z)).contact;
      assert.equal(contact?.phone, '+8801722222222');
      assert.equal(JSON.stringify(await matches.detail(m1.actor, z)).includes('SECRET'), false);
    },
  );

  await t.test(
    'a client nobody looks after can be asked; nobody is told, and an admin can still answer',
    async () => {
      const { connectionId } = await ask(m1.actor, orphan);
      const told = await interestLines(abir.actor, inbox());
      assert.ok(!told.items.some((n) => n.forProfileId === orphan));
      await connections.staffRespond(boss.actor, orphan, connectionId, false, 'c');
      assert.equal((await connectionRows(m1.profileId, orphan))[0].status, 'declined');
    },
  );

  await t.test('a name appears in the inbox only if staff let the member see names', async () => {
    const a = await member('Hidden Hal', 'male');
    const b = await member('Hidden Hana', 'female');
    await release(a.profileId, b.profileId);
    await ask(a.actor, b.profileId);
    assert.equal((await interestLines(b.actor, inbox())).items[0]!.about?.fullName, 'Hidden Hal');
    await candidates.saveSettings(
      boss.actor,
      b.profileId,
      { cap: 50, visibleFields: ['age'], allowCodeSearch: false },
      'c',
    );
    const item = (await interestLines(b.actor, inbox())).items[0]!;
    assert.equal(item.about?.fullName, null);
    assert.ok(item.about?.memberCode);
    // And the profile they may open shows no name either.
    assert.equal((await matches.detail(b.actor, a.profileId)).profile.fullName, undefined);
  });

  await t.test(
    'the events are recorded, and the application cannot delete a connection or a notification',
    async () => {
      const events = await admin.query(
        `SELECT DISTINCT event->>'type' AS type FROM matrimony.event_outbox WHERE agency_id = $1 AND event->>'type' LIKE 'interest.%'`,
        [agencyId],
      );
      const types = events.rows.map((r) => r.type);
      for (const type of [
        'interest.requested',
        'interest.accepted',
        'interest.declined',
        'interest.withdrawn',
        'interest.contact_shared',
      ])
        assert.ok(types.includes(type), type);
      await assert.rejects(pool.query('DELETE FROM matrimony.interests'), /permission denied/);
      await assert.rejects(pool.query('DELETE FROM matrimony.notifications'), /permission denied/);
      await assert.rejects(
        pool.query(`UPDATE matrimony.notifications SET template_key = 'interest.received'`),
        /permission denied/,
      );
    },
  );

  await t.test('another agency never sees any of it', async () => {
    const foreign = await member('Foreign Fred', 'male', elsewhereId);
    assert.deepEqual((await interestLines(foreign.actor, inbox())).items, []);
    assert.deepEqual((await connections.list(foreign.actor, box('connected'))).items, []);
    await assert.rejects(
      matches.detail(foreign.actor, m1.profileId),
      refused(404, 'PROFILE_NOT_FOUND'),
    );
    await assert.rejects(
      connections.staffList(foreignBoss.actor, z),
      refused(404, 'PROFILE_NOT_FOUND'),
    );
  });
});
