import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { clientInputSchema } from '../../src/bo/client.js';
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
import { ProfileDbService } from '../../src/db/service/profile-db-service.js';
import { ReviewDbService } from '../../src/db/service/review-db-service.js';
import { CvRepository } from '../../src/db/raw/repository/cv-repository.js';
import { CvDbService } from '../../src/db/service/cv-db-service.js';
import { CvProcess } from '../../src/process/cv-process.js';
import { CvService } from '../../src/service/cv-service.js';
import type { FileStorage } from '../../src/storage/service/file-storage.js';
import { AppError } from '../../src/exception/app-error.js';
import { CandidateService } from '../../src/service/candidate-service.js';
import { ClientService } from '../../src/service/client-service.js';
import { ConnectionService } from '../../src/service/connection-service.js';
import { ProfileService, type ProfileActor } from '../../src/service/profile-service.js';
import { ReviewService } from '../../src/service/review-service.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const NOW = new Date();
const refused = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('a profile CV on real PostgreSQL', async (t) => {
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
      `cv-${tag}`,
      `cv-${tag}.localhost`,
      elsewhereId,
      `cv2-${tag}`,
      `cv2-${tag}.localhost`,
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
  // ---- the CV module, with files kept in memory ----------------------------------------------
  const files = new Map<string, Buffer>();
  const storage: FileStorage = {
    put: async (key, data) => {
      files.set(key, data);
    },
    get: async (key) => files.get(key) ?? null,
    delete: async (key) => {
      files.delete(key);
    },
  };
  const cvs = new CvProcess(
    new CvService(new CvDbService(db, new CvRepository(), new EventRepository())),
    storage,
    pino({ level: 'silent' }),
  );
  const pdf = (marker: string) =>
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Title (${marker}) >>\nendobj\ntrailer\n<< >>\n%%EOF\n`);
  const own = { kind: 'own' } as const;

  const m1 = await member('Mahir One', 'male');
  const m2 = await member('Nila Two', 'female');
  const m3 = await member('Third Tuli', 'female');
  const z = await assisted('Zara Client', 'female', abir);
  const connect = async (a: typeof m1, b: typeof m2) => {
    await release(a.profileId, b.profileId);
    const sent = await connections.send(a.actor, b.profileId, 'c');
    await connections.review(boss.actor, sent.connectionId, true, 'c');
    await connections.respond(b.actor, sent.connectionId, true, 'c');
  };

  await t.test('a member uploads: it waits, and nobody else can see it', async () => {
    const state = await cvs.upload(m1.actor, own, pdf('first'), 'My%20CV.pdf', 'c');
    assert.equal(state.current, null);
    assert.equal(state.replacement?.state, 'waiting');
    assert.equal(state.replacement?.fileName, 'My CV.pdf');
    assert.equal(state.replacement?.uploadedByStaff, false);
    // The owner can open it; another member, connected or not, gets nothing.
    assert.deepEqual((await cvs.file(m1.actor, own, 'replacement')).bytes, pdf('first'));
    assert.equal(await cvs.infoOfConnection(m2.actor, m1.profileId), null);
    await assert.rejects(
      cvs.fileOfConnection(m2.actor, m1.profileId),
      refused(404, 'CV_NOT_FOUND'),
    );
    // And it is never in what a connected person may read before approval, nor a file name in the state.
    assert.equal(JSON.stringify(state).includes(m1.profileId), false);
  });

  await t.test(
    'approving publishes it; replacing keeps the old one until the new is approved',
    async () => {
      const approved = await cvs.review(boss.actor, m1.profileId, true, null, 'c');
      assert.equal(approved.current?.fileName, 'My CV.pdf');
      assert.equal(approved.replacement, null);

      const second = await cvs.upload(m1.actor, own, pdf('second'), 'new.pdf', 'c');
      assert.equal(second.current?.fileName, 'My CV.pdf');
      assert.equal(second.replacement?.state, 'waiting');
      // The old file is still there for readers until the new one is approved.
      const oldKeys = [...files.keys()];
      assert.equal(oldKeys.length, 2);
      assert.deepEqual((await cvs.file(m1.actor, own, 'current')).bytes, pdf('first'));

      // Registering gave the member an agent; the other agent does not look after them.
      const looksAfter = (
        await admin.query(`SELECT assigned_agent_id FROM matrimony.member_profiles WHERE id = $1`, [
          m1.profileId,
        ])
      ).rows[0].assigned_agent_id as string;
      const stranger = looksAfter === abir.id ? rival : abir;
      const swapped = await cvs
        .review(stranger.actor, m1.profileId, true, null, 'c')
        .catch((e) => e);
      assert.ok(swapped instanceof AppError);
      assert.equal((swapped as AppError).status, 404);
      const done = await cvs.review(boss.actor, m1.profileId, true, null, 'c');
      assert.equal(done.current?.fileName, 'new.pdf');
      assert.equal(done.replacement, null);
      assert.equal(files.size, 1, 'the old file is deleted');
      assert.deepEqual((await cvs.file(m1.actor, own, 'current')).bytes, pdf('second'));
    },
  );

  await t.test('a rejected replacement shows its reason and leaves the CV as it was', async () => {
    await cvs.upload(m1.actor, own, pdf('third'), 'third.pdf', 'c');
    const rejected = await cvs.review(boss.actor, m1.profileId, false, 'Too blurry to read.', 'c');
    assert.equal(rejected.current?.fileName, 'new.pdf');
    assert.equal(rejected.replacement?.state, 'rejected');
    assert.equal(rejected.replacement?.reviewerNotes, 'Too blurry to read.');
    await assert.rejects(
      cvs.review(boss.actor, m1.profileId, true, null, 'c'),
      refused(409, 'CV_NOT_WAITING'),
    );
    // A new upload replaces the rejected one, and its file goes.
    const before = files.size;
    const again = await cvs.upload(m1.actor, own, pdf('fourth'), 'fourth.pdf', 'c');
    assert.equal(again.replacement?.state, 'waiting');
    assert.equal(files.size, before, 'the rejected file was deleted');
    await cvs.review(boss.actor, m1.profileId, true, null, 'c');
    assert.equal(files.size, 1);
  });

  await t.test('only an accepted connection reads it, and nobody else does', async () => {
    // Not connected: the same answer as no CV at all.
    assert.equal(await cvs.infoOfConnection(m2.actor, m1.profileId), null);
    await connect(m1, m2);
    const info = await cvs.infoOfConnection(m2.actor, m1.profileId);
    assert.equal(info?.fileName, 'fourth.pdf');
    assert.deepEqual((await cvs.fileOfConnection(m2.actor, m1.profileId)).bytes, pdf('fourth'));
    // A third member who is not connected, and the other agency's member, get nothing.
    assert.equal(await cvs.infoOfConnection(m3.actor, m1.profileId), null);
    await assert.rejects(
      cvs.fileOfConnection(m3.actor, m1.profileId),
      refused(404, 'CV_NOT_FOUND'),
    );
    const foreign = await member('Foreign Fay', 'female', elsewhereId);
    assert.equal(await cvs.infoOfConnection(foreign.actor, m1.profileId), null);
    // Staff are not members: they read a client's CV through the staff route.
    await assert.rejects(
      cvs.fileOfConnection(boss.actor, m1.profileId),
      refused(403, 'ROLE_FORBIDDEN'),
    );
  });

  await t.test('staff keep a CV for an assisted client, which is published at once', async () => {
    const target = { kind: 'client', profileId: z } as const;
    const state = await cvs.upload(abir.actor, target, pdf('client'), 'zara.pdf', 'c');
    assert.equal(state.current?.fileName, 'zara.pdf');
    assert.equal(state.current?.uploadedByStaff, true);
    assert.equal(state.replacement, null);
    assert.deepEqual((await cvs.file(abir.actor, target, 'current')).bytes, pdf('client'));
    // An agent who does not look after her cannot see or change it.
    await assert.rejects(cvs.state(rival.actor, target), refused(404, 'PROFILE_NOT_FOUND'));
    await assert.rejects(
      cvs.upload(rival.actor, target, pdf('x'), 'x.pdf', 'c'),
      refused(404, 'PROFILE_NOT_FOUND'),
    );
    // A member who runs their own profile is not changed by staff, but staff see their CV.
    await assert.rejects(
      cvs.upload(boss.actor, { kind: 'client', profileId: m2.profileId }, pdf('x'), 'x.pdf', 'c'),
      refused(403, 'PROFILE_SELF_SERVICE'),
    );
    assert.equal(
      (await cvs.state(boss.actor, { kind: 'client', profileId: m1.profileId })).current?.fileName,
      'fourth.pdf',
    );
    // Members cannot use the staff route, nor staff the member route.
    await assert.rejects(cvs.state(m1.actor, target), refused(403, 'ROLE_FORBIDDEN'));
    await assert.rejects(cvs.state(boss.actor, own), refused(403, 'ROLE_FORBIDDEN'));
  });

  await t.test(
    'what is not a PDF, is too big or carries active content is refused and nothing is stored',
    async () => {
      const before = files.size;
      const bad: [Buffer, number, string][] = [
        [Buffer.from('not a pdf at all, just some text'), 415, 'CV_NOT_A_PDF'],
        [Buffer.from('%PDF-1.4\nbut no end'), 415, 'CV_NOT_A_PDF'],
        [
          Buffer.from(
            '%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF\n',
          ),
          422,
          'CV_ACTIVE_CONTENT',
        ],
        [Buffer.from('%PDF-1.4\n<< /J#61vaScript (x) >>\n%%EOF\n'), 422, 'CV_ACTIVE_CONTENT'],
        [Buffer.alloc(5 * 1024 * 1024 + 1, 0x41), 413, 'CV_TOO_LARGE'],
      ];
      for (const [bytes, status, code] of bad) {
        await assert.rejects(cvs.upload(m3.actor, own, bytes, 'x.pdf', 'c'), refused(status, code));
      }
      assert.equal(files.size, before);
      assert.equal((await cvs.state(m3.actor, own)).replacement, null);
    },
  );

  await t.test(
    'removing takes the CV and its files away, and connected people lose it',
    async () => {
      const gone = await cvs.remove(m1.actor, own, 'c');
      assert.deepEqual(gone, { current: null, replacement: null });
      assert.equal(await cvs.infoOfConnection(m2.actor, m1.profileId), null);
      await assert.rejects(cvs.file(m1.actor, own, 'current'), refused(404, 'CV_NOT_FOUND'));
      assert.equal(
        [...files.keys()].some((key) => key.includes(m1.profileId)),
        false,
      );
    },
  );

  await t.test(
    'the database keeps one published and one waiting CV, and the app cannot delete',
    async () => {
      await cvs.upload(m2.actor, own, pdf('m2'), 'm2.pdf', 'c');
      await cvs.review(boss.actor, m2.profileId, true, null, 'c');
      const key = `${agencyId}/${m2.profileId}/${randomUUID()}.pdf`;
      // A second published CV for the same profile is refused by the database itself.
      await assert.rejects(
        admin.query(
          `INSERT INTO matrimony.profile_cvs (agency_id, profile_id, storage_key, file_name, byte_size, status, uploaded_by_account_id)
         VALUES ($1, $2, $3, 'dup.pdf', 10, 'published', $4)`,
          [agencyId, m2.profileId, key, m2.id],
        ),
        /one_published_cv/,
      );
      await assert.rejects(pool.query('DELETE FROM matrimony.profile_cvs'), /permission denied/);
      await assert.rejects(
        pool.query(`UPDATE matrimony.profile_cvs SET storage_key = 'x'`),
        /permission denied/,
      );
    },
  );
});
