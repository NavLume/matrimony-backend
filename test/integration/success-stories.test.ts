import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/migrate.js';
import { parsePublicConfig } from '../../src/bo/public-config.js';
import { manualStoryCreateSchema, manualStoryUpdateSchema } from '../../src/bo/success-story.js';
import { Database } from '../../src/db/config/database.js';
import { CoupleMatchRepository } from '../../src/db/raw/repository/couple-match-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { SiteContentRepository } from '../../src/db/raw/repository/site-content-repository.js';
import { CoupleMatchDbService } from '../../src/db/service/couple-match-db-service.js';
import { SiteContentDbService } from '../../src/db/service/site-content-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { CoupleMatchService } from '../../src/service/couple-match-service.js';
import type { ProfileActor } from '../../src/service/profile-service.js';
import { SiteContentService } from '../../src/service/site-content-service.js';
import { LocalFileStorage } from '../../src/storage/repository/local-file-storage.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const refused = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;
const violates = (constraint: string) => (error: unknown) =>
  (error as { constraint?: string }).constraint === constraint;

await test('success stories added by hand on real PostgreSQL', async (t) => {
  await migrate(databaseUrl, false);
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scaffold_test_app') THEN
 CREATE ROLE scaffold_test_app LOGIN PASSWORD 'test-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
 GRANT matrimony_runtime TO scaffold_test_app;`);

  const tag = randomUUID().slice(0, 8);
  const agencyId = randomUUID();
  const elsewhereId = randomUUID();
  await admin.query(
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,$2,$3,'Stories one'),($4,$5,$6,'Stories two')`,
    [
      agencyId,
      `sto-${tag}`,
      `sto-${tag}.localhost`,
      elsewhereId,
      `sto2-${tag}`,
      `sto2-${tag}.localhost`,
    ],
  );
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const db = new Database(new Pool({ connectionString: runtimeUrl.href, max: 4 }));
  const directory = await mkdtemp(join(tmpdir(), 'matrimony-stories-'));
  t.after(async () => {
    await db.close();
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });

  const storage = new LocalFileStorage(directory);
  const stories = new CoupleMatchService(
    new CoupleMatchDbService(db, new CoupleMatchRepository(), new EventRepository()),
    undefined,
    undefined,
    storage,
  );
  const site = new SiteContentService(
    new SiteContentDbService(db, new SiteContentRepository(), new EventRepository()),
    storage,
  );
  const account = async (role: ProfileActor['role'], inAgency = agencyId) => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO matrimony.accounts(id,agency_id,role,display_name,status,email,auth_issuer,auth_subject)
       VALUES ($1,$2,$3,'Staff','active',$4,'https://test.example',$5)`,
      [id, inAgency, role, `${id}@example.com`, id],
    );
    return { agencyId: inAgency, accountId: id, role } as ProfileActor;
  };
  const boss = await account('admin');
  const agent = await account('agent');
  const foreignBoss = await account('admin', elsewhereId);
  const publicNames = async (agency = agencyId) =>
    (await site.withStories(agency, parsePublicConfig({}))).successStories.map((s) => s.names.en);

  await t.test(
    'a draft without permission cannot be published, by the service or the database',
    async () => {
      const draft = await stories.createManualStory(
        boss,
        manualStoryCreateSchema.parse({
          names: { bn: 'রহিম ও করিমা', en: 'Rahim and Karima' },
          text: { en: 'They married in 2014.' },
          weddingDate: '2014-02-14',
        }),
        'c1',
      );
      assert.equal(draft.source, 'manual');
      assert.equal(draft.status, 'draft');
      assert.equal(draft.canPublish, false);
      assert.equal(draft.year, 2014);
      assert.equal(draft.weddingDate, '2014-02-14');
      await assert.rejects(
        () => stories.setStoryStatus(boss, draft.id, 'published', 'c2'),
        refused(409, 'CONSENT_MISSING'),
      );
      await assert.rejects(
        () =>
          db.transaction(agencyId, (tx) =>
            tx.query(`UPDATE matrimony.success_stories SET status = 'published' WHERE id = $1`, [
              draft.id,
            ]),
          ),
        violates('success_stories_published_has_consent'),
      );
      assert.deepEqual(await publicNames(), []);
      await assert.rejects(
        () =>
          stories.createManualStory(
            agent,
            manualStoryCreateSchema.parse({ names: { en: 'X' } }),
            'c',
          ),
        refused(403, 'ROLE_FORBIDDEN'),
      );

      // Recording the permission lets it be published, and it shows on the public site like a match story.
      const edited = await stories.updateManualStory(
        boss,
        draft.id,
        manualStoryUpdateSchema.parse({
          names: { en: 'Rahim and Karima' },
          weddingDate: '2014-02-14',
          consent: { note: 'written permission from both, 20 Nov 2026' },
        }),
        'c3',
      );
      assert.equal(edited.canPublish, true);
      assert.equal(edited.consentNote, 'written permission from both, 20 Nov 2026');
      assert.equal(edited.story, null);
      await stories.setStoryStatus(boss, draft.id, 'published', 'c4');
      assert.deepEqual(await publicNames(), ['Rahim and Karima']);

      // The permission of a story on the site cannot be taken away; the same note keeps its time.
      await assert.rejects(
        () =>
          stories.updateManualStory(
            boss,
            draft.id,
            manualStoryUpdateSchema.parse({ names: { en: 'Rahim and Karima' } }),
            'c5',
          ),
        refused(409, 'STORY_PUBLISHED'),
      );
      const again = await stories.updateManualStory(
        boss,
        draft.id,
        manualStoryUpdateSchema.parse({
          names: { en: 'Rahim and Karima' },
          consent: { note: 'written permission from both, 20 Nov 2026' },
        }),
        'c6',
      );
      assert.equal(again.consentRecordedAt, edited.consentRecordedAt);

      const events = await admin.query(
        `SELECT event FROM matrimony.event_outbox WHERE agency_id = $1 AND event->>'subjectId' = $2`,
        [agencyId, draft.id],
      );
      // Metadata only: never the couple's names, words or the permission note.
      assert.doesNotMatch(JSON.stringify(events.rows), /Rahim|permission|রহিম/);
      assert.deepEqual(events.rows.map((r: { event: { type: string } }) => r.event.type).sort(), [
        'story.created',
        'story.published',
        'story.updated',
        'story.updated',
      ]);
    },
  );

  await t.test(
    'another agency neither sees nor changes them (RLS and explicit predicates)',
    async () => {
      const shown = await stories.createManualStory(
        boss,
        manualStoryCreateSchema.parse({
          names: { en: 'Arif and Nusrat' },
          consent: { note: 'both agreed in the office' },
          publish: true,
        }),
        'c7',
      );
      assert.equal(shown.status, 'published');
      assert.deepEqual((await stories.listStories(foreignBoss)).stories, []);
      assert.deepEqual(await publicNames(elsewhereId), []);
      await assert.rejects(
        () => stories.setStoryStatus(foreignBoss, shown.id, 'hidden', 'c'),
        refused(404, 'STORY_NOT_FOUND'),
      );
      await assert.rejects(
        () =>
          stories.updateManualStory(
            foreignBoss,
            shown.id,
            manualStoryUpdateSchema.parse({ names: { en: 'Taken over' } }),
            'c',
          ),
        refused(404, 'STORY_NOT_FOUND'),
      );
      const leaked = await db.transaction(elsewhereId, (tx) =>
        tx.query(`SELECT id FROM matrimony.success_stories WHERE id = $1`, [shown.id]),
      );
      assert.equal(leaked.rows.length, 0);
      const listed = (await stories.listStories(boss)).stories.map((s) => s.id);
      assert.ok(listed.includes(shown.id));
    },
  );

  await t.test('a story by hand never has a match, and a match story always has one', async () => {
    await assert.rejects(
      () =>
        admin.query(
          `INSERT INTO matrimony.success_stories (agency_id, source, match_id, names, created_by)
           VALUES ($1, 'match', NULL, '{}'::jsonb, $2)`,
          [agencyId, boss.accountId],
        ),
      violates('success_stories_source_match'),
    );
    await assert.rejects(
      () =>
        admin.query(
          `INSERT INTO matrimony.success_stories (agency_id, source, names, consent_a_at, created_by)
           VALUES ($1, 'manual', '{}'::jsonb, now(), $2)`,
          [agencyId, boss.accountId],
        ),
      violates('success_stories_consent_kind'),
    );
  });

  await t.test(
    'removal empties a story by hand, deletes its photo and clears the permission for good',
    async () => {
      const story = await stories.createManualStory(
        boss,
        manualStoryCreateSchema.parse({
          names: { en: 'Kamal and Salma' },
          text: { en: 'Married in 2012.' },
          year: 2012,
          consent: { note: 'written permission, 2026' },
          publish: true,
        }),
        'c8',
      );
      const picture = await sharp({
        create: { width: 900, height: 700, channels: 3, background: '#a33' },
      })
        .jpeg()
        .toBuffer();
      await site.setStoryPhoto(boss, story.id, picture, 'c9');
      const withPhoto = (await stories.listStories(boss)).stories.find((s) => s.id === story.id)!;
      assert.equal(withPhoto.hasPhoto, true);
      const files = await readdir(join(directory, agencyId, 'stories'));
      assert.equal(files.length, 1);
      assert.ok(
        (await site.withStories(agencyId, parsePublicConfig({}))).successStories.some((s) =>
          s.photoUrl?.endsWith(files[0]!),
        ),
      );

      await assert.rejects(
        () => stories.removeStory(agent, story.id, 'They asked us to', 'c'),
        refused(403, 'ROLE_FORBIDDEN'),
      );
      await stories.removeStory(boss, story.id, 'The couple asked us to', 'c10');
      const removed = (await stories.listStories(boss)).stories.find((s) => s.id === story.id)!;
      assert.equal(removed.removed, true);
      assert.equal(removed.status, 'hidden');
      assert.deepEqual(removed.names, {});
      assert.equal(removed.story, null);
      assert.equal(removed.consentNote, null);
      assert.equal(removed.canPublish, false);
      assert.equal(removed.hasPhoto, false);
      assert.deepEqual(await readdir(join(directory, agencyId, 'stories')), []);
      assert.ok(!(await publicNames()).includes('Kamal and Salma'));
      await assert.rejects(
        () => stories.setStoryStatus(boss, story.id, 'published', 'c'),
        refused(409, 'CONSENT_MISSING'),
      );
      await assert.rejects(
        () =>
          stories.updateManualStory(
            boss,
            story.id,
            manualStoryUpdateSchema.parse({
              names: { en: 'Back again' },
              consent: { note: 'agreed again' },
            }),
            'c',
          ),
        refused(409, 'STORY_ALREADY_REMOVED'),
      );
    },
  );
});
