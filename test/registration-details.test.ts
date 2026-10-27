import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrationInputSchema } from '../src/bo/registration.js';
import {
  detailsToProfileInput,
  registrationDetailsBaseSchema,
  registrationDetailsSchema,
} from '../src/bo/registration-details.js';
import type { Account } from '../src/bo/identity.js';
import type { RegistrationUnit } from '../src/db/service/registration-db-service.js';
import { RegistrationService } from '../src/service/registration-service.js';
import { agency } from './fixtures.js';

const details = {
  managedFor: 'child',
  fullName: ' Nusrat Jahan ',
  dateOfBirth: '1999-03-01',
  gender: 'female',
  maritalStatus: 'never_married',
  religionCode: 'islam',
  countryCode: 'bangladesh',
  districtCode: 'dhaka',
  highestDegreeCode: 'bachelors',
  occupationCode: 'salaried',
  professionCode: 'teacher',
  phone: '01712-345678',
};

const issues = (value: unknown) => {
  const result = registrationDetailsSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}:${i.message}`);
};

await test('the answers are checked with the profile codes, and the mobile number is made international', () => {
  const parsed = registrationDetailsSchema.parse(details);
  assert.equal(parsed.fullName, 'Nusrat Jahan');
  assert.equal(parsed.phone, '+8801712345678');
  assert.deepEqual(issues({ ...details, gender: 'other' }), ['gender:invalidOption']);
  assert.deepEqual(issues({ ...details, phone: '12345' }), ['phone:invalidPhone']);
  assert.deepEqual(issues({ ...details, phone: undefined }), ['phone:required']);
  assert.deepEqual(issues({ ...details, extra: 1 }).length, 1);
});

await test('a district is needed for Bangladesh only; the age limits apply', () => {
  assert.deepEqual(issues({ ...details, districtCode: undefined }), ['districtCode:required']);
  assert.deepEqual(issues({ ...details, countryCode: 'canada', districtCode: undefined }), []);
  assert.deepEqual(issues({ ...details, dateOfBirth: '2015-01-01' }), ['dateOfBirth:underAge']);
  assert.deepEqual(issues({ ...details, dateOfBirth: '1800-01-01' }), ['dateOfBirth:tooOld']);
  assert.deepEqual(issues({ ...details, dateOfBirth: 'soon' }), ['dateOfBirth:invalidDate']);
});

await test('the phone path asks for the same answers without a number', () => {
  const without: Record<string, unknown> = { ...details };
  delete without.phone;
  assert.equal(registrationDetailsBaseSchema.safeParse(without).success, true);
  assert.equal(registrationDetailsBaseSchema.safeParse(details).success, false);
});

await test('the answers become a draft profile: the person, the place, the number, and no district abroad', () => {
  const input = detailsToProfileInput(
    registrationDetailsSchema.parse(details),
    new Date('2026-10-28T00:00:00Z'),
  );
  assert.equal(input.profile.managedFor, 'child');
  assert.equal(input.profile.fullName, 'Nusrat Jahan');
  assert.equal(input.profile.currentDistrictCode, 'dhaka');
  assert.equal(input.profile.occupationCode, 'salaried');
  assert.equal(input.profile.professionCode, 'teacher');
  assert.equal(input.contact.phone, '+8801712345678');
  const abroad = detailsToProfileInput(
    registrationDetailsSchema.parse({ ...details, countryCode: 'canada' }),
    new Date('2026-10-28T00:00:00Z'),
  );
  assert.equal(abroad.profile.currentDistrictCode, null);
});

await test('registering by email may carry the answers; nothing else is added to the input', () => {
  const body = {
    email: 'rahim@example.com',
    password: 'a long enough password',
    displayName: 'Rahim',
    locale: 'bn',
    acceptTerms: true,
    acceptPrivacy: true,
  };
  assert.equal(registrationInputSchema.parse(body).details, undefined);
  assert.equal(
    registrationInputSchema.parse({ ...body, details }).details?.phone,
    '+8801712345678',
  );
  assert.equal(
    registrationInputSchema.safeParse({ ...body, details: { fullName: 'x' } }).success,
    false,
  );
});

/** A registration service whose storage creates the member, to see what is asked of the profile. */
function setup(created = true) {
  const account: Account = { id: 'a1', agencyId: agency, role: 'member', displayName: 'Rahim' };
  const unit = {
    findByEmail: async () => null,
    createMember: async () => (created ? account : null),
    createCredential: async () => undefined,
    recordConsents: async () => undefined,
    appendEvent: async () => undefined,
  } as unknown as RegistrationUnit;
  const service = new RegistrationService({
    inTransaction: async (_a: string, work: (u: RegistrationUnit) => Promise<unknown>) =>
      work(unit),
  } as never);
  const started: unknown[] = [];
  service.afterRegistered = async (_agency, member, answers) =>
    void started.push([member.id, answers.fullName]);
  return { service, started };
}
const registration = {
  displayName: 'Rahim',
  locale: 'bn' as const,
  onBehalfOfOther: false,
  termsVersion: 't',
  privacyVersion: 'p',
};
const verified = (withDetails: boolean) => ({
  email: 'rahim@example.com',
  passwordHash: 'h',
  registration: {
    ...registration,
    details: withDetails ? registrationDetailsSchema.parse(details) : undefined,
  },
});

await test('the draft profile is started once the account exists, and only when answers were given', async () => {
  const a = setup();
  await a.service.createVerified(agency, verified(true), 'r');
  assert.deepEqual(a.started, [['a1', 'Nusrat Jahan']]);
  const b = setup();
  await b.service.createVerified(agency, verified(false), 'r');
  assert.deepEqual(b.started, []);
  const lost = setup(false);
  await lost.service.createVerified(agency, verified(true), 'r');
  assert.deepEqual(lost.started, []);
});
