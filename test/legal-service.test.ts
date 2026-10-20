import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalInputSchema, platformLegalVersions, versionOf } from '../src/bo/legal.js';
import { PRIVACY_VERSION, TERMS_VERSION, toRegistration } from '../src/bo/registration.js';
import type { LegalDocument, LegalInput, LegalKind } from '../src/bo/legal.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import { LegalService } from '../src/service/legal-service.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const admin = {
  agencyId: AGENCY,
  accountId: '22222222-2222-4222-8222-222222222222',
  role: 'admin' as const,
};
const agent = { ...admin, role: 'agent' as const };

function setup() {
  const rows: Record<LegalKind, LegalDocument[]> = { terms: [], privacy: [] };
  const events: WorkflowEvent[] = [];
  const db = {
    current: async (_agency: string, kind: LegalKind): Promise<LegalDocument> =>
      rows[kind].at(-1) ?? { kind, version: 0 },
    save: async (
      _agency: string,
      kind: LegalKind,
      input: LegalInput,
      _account: string,
      event: WorkflowEvent,
    ): Promise<LegalDocument> => {
      const added: LegalDocument = {
        kind,
        version: rows[kind].length + 1,
        title: input.title,
        body: input.body,
      };
      rows[kind].push(added);
      events.push(event);
      return added;
    },
  };
  return { rows, events, service: new LegalService(db, () => new Date('2026-10-20T10:00:00Z')) };
}

await test('without text of its own an agency records the platform draft versions', async () => {
  const { service } = setup();
  assert.deepEqual(await service.versions(AGENCY), {
    terms: TERMS_VERSION,
    privacy: PRIVACY_VERSION,
  });
  assert.deepEqual(await platformLegalVersions(AGENCY), {
    terms: TERMS_VERSION,
    privacy: PRIVACY_VERSION,
  });
  const publicTerms = await service.publicDocument(AGENCY, 'terms');
  assert.equal(publicTerms.custom, false);
  assert.equal(publicTerms.body, undefined);
});

await test('each save is a new numbered version and the latest one is public', async () => {
  const { service, rows, events } = setup();
  await service.save(admin, 'terms', legalInputSchema.parse({ body: { en: 'First' } }), 'r');
  await service.save(
    admin,
    'terms',
    legalInputSchema.parse({ title: { en: 'Terms' }, body: { en: 'Second', bn: 'দ্বিতীয়' } }),
    'r',
  );
  assert.equal(rows.terms.length, 2);
  assert.equal((await service.versions(AGENCY)).terms, 'agency-v2');
  assert.equal((await service.versions(AGENCY)).privacy, PRIVACY_VERSION);
  const shown = await service.publicDocument(AGENCY, 'terms');
  assert.equal(shown.custom, true);
  assert.equal(shown.version, 'agency-v2');
  assert.equal(shown.body?.en, 'Second');
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, 'legal.updated');
});

await test('saving empty text goes back to the platform draft but keeps the history', async () => {
  const { service, rows } = setup();
  await service.save(admin, 'privacy', legalInputSchema.parse({ body: { en: 'Own text' } }), 'r');
  await service.save(admin, 'privacy', legalInputSchema.parse({ body: { en: '  ', bn: '' } }), 'r');
  assert.equal(rows.privacy.length, 2);
  assert.equal((await service.versions(AGENCY)).privacy, PRIVACY_VERSION);
  assert.equal((await service.publicDocument(AGENCY, 'privacy')).custom, false);
});

await test('only an admin reads or writes the documents', async () => {
  const { service } = setup();
  await assert.rejects(() => service.get(agent), { code: 'ROLE_FORBIDDEN' });
  await assert.rejects(() => service.save(agent, 'terms', legalInputSchema.parse({}), 'r'), {
    code: 'ROLE_FORBIDDEN',
  });
});

await test('the text is trimmed, line endings are unified, and too much text is refused', () => {
  const parsed = legalInputSchema.parse({ body: { en: '  line one\r\nline two  ' } });
  assert.equal(parsed.body?.en, 'line one\nline two');
  assert.equal(legalInputSchema.safeParse({ body: { en: 'x'.repeat(40001) } }).success, false);
  assert.equal(legalInputSchema.safeParse({ other: 1 }).success, false);
});

await test('a registration records the versions it is given, and the draft ones by default', () => {
  const input = {
    email: 'a@example.test',
    password: 'a-long-password-1',
    displayName: 'A',
    locale: 'en' as const,
    onBehalfOfOther: false,
    acceptTerms: true,
    acceptPrivacy: true,
  };
  const custom = toRegistration(input as never, { terms: 'agency-v3', privacy: 'agency-v1' });
  assert.equal(custom.termsVersion, 'agency-v3');
  assert.equal(custom.privacyVersion, 'agency-v1');
  assert.equal(toRegistration(input as never).termsVersion, TERMS_VERSION);
  assert.equal(versionOf('terms', { version: 4, body: { en: 'x' } }), 'agency-v4');
});
