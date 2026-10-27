import { z } from 'zod';
import {
  COUNTRIES,
  DEGREES,
  DISTRICTS,
  GENDERS,
  MANAGED_FOR,
  MARITAL_STATUSES,
  OCCUPATIONS,
  PROFESSIONS,
  RELIGIONS,
} from './dictionaries.js';
import { phoneSchema } from './phone-number.js';
import { ageOn, MAX_AGE, MIN_AGE, profileInputSchema, type ProfileInput } from './profile.js';

/**
 * The few things asked while registering, so the new member's profile starts as a filled-in draft
 * and the agency knows who they are talking to. They are the same fields as My Profile, with the
 * same codes; nothing is stored until the account exists. Validation messages are stable keys, as
 * elsewhere, so the frontend can translate them.
 */
const fail = (key: string) => ({ error: key });
const choice = <T extends string>(values: readonly T[]) => z.enum(values, fail('invalidOption'));

const detailsShape = {
  /** Who the profile is for: the member, a child, a sibling, a relative or someone else. */
  managedFor: choice(MANAGED_FOR),
  fullName: z.string(fail('required')).trim().min(1, fail('required')).max(100, fail('tooLong')),
  /** Checked against the age limits when the draft is made (see detailsToProfileInput). */
  dateOfBirth: z.string(fail('required')).trim().min(1, fail('required')),
  gender: choice(GENDERS),
  maritalStatus: choice(MARITAL_STATUSES),
  religionCode: choice(RELIGIONS),
  countryCode: choice(COUNTRIES),
  /** Asked only for Bangladesh. */
  districtCode: choice(DISTRICTS).optional(),
  highestDegreeCode: choice(DEGREES),
  /** The kind of work: salaried, business, student and so on. */
  occupationCode: choice(OCCUPATIONS),
  /** What the person does, when they work. */
  professionCode: choice(PROFESSIONS).optional(),
};

/** Without the number: the phone path already has it, proved by a code. */
const checkDetails = (
  value: { countryCode: string; districtCode?: string; dateOfBirth: string },
  ctx: z.RefinementCtx,
) => {
  const age = ageOn(value.dateOfBirth, new Date());
  if (age === null || age < 0)
    ctx.addIssue({ code: 'custom', message: 'invalidDate', path: ['dateOfBirth'] });
  else if (age < MIN_AGE)
    ctx.addIssue({ code: 'custom', message: 'underAge', path: ['dateOfBirth'] });
  else if (age > MAX_AGE)
    ctx.addIssue({ code: 'custom', message: 'tooOld', path: ['dateOfBirth'] });
  if (value.countryCode === 'bangladesh' && !value.districtCode)
    ctx.addIssue({ code: 'custom', message: 'required', path: ['districtCode'] });
};

export const registrationDetailsBaseSchema = z
  .object(detailsShape)
  .strict()
  .superRefine(checkDetails);
export type RegistrationDetailsBase = z.output<typeof registrationDetailsBaseSchema>;

/** The mobile number the agency will call. Checked for its shape, never by a text message. */
export const registrationDetailsSchema = z
  .object({ ...detailsShape, phone: phoneSchema })
  .strict()
  .superRefine(checkDetails);
export type RegistrationDetails = z.output<typeof registrationDetailsSchema>;

/** The same answers as a profile to save, checked by the profile's own rules (the age limits). */
export function detailsToProfileInput(details: RegistrationDetails, now: Date): ProfileInput {
  return profileInputSchema(now).parse({
    profile: {
      managedFor: details.managedFor,
      fullName: details.fullName,
      dateOfBirth: details.dateOfBirth,
      gender: details.gender,
      maritalStatus: details.maritalStatus,
      religionCode: details.religionCode,
      countryCode: details.countryCode,
      currentDistrictCode: details.countryCode === 'bangladesh' ? details.districtCode : undefined,
      highestDegreeCode: details.highestDegreeCode,
      occupationCode: details.occupationCode,
      professionCode: details.professionCode,
    },
    contact: { phone: details.phone },
  });
}
