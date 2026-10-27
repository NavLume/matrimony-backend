import { z } from 'zod';
import { COUNTRIES, DISTRICTS, PROFESSIONS, RELIGIONS } from './dictionaries.js';
import { phoneCodeSchema } from './phone.js';
import { phoneSchema } from './phone-number.js';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * "Meet our members" (27 October 2026): blurred profile cards on the agency's public website.
 *
 * - The agency's admin switches it on (it is off until then) and chooses which published profiles appear.
 * - Nobody is asked for a tick: the agency's terms say it may happen, a member (or the staff who look after them)
 *   can switch a profile off, and the admin can remove anyone.
 * - A card carries only generic facts and a heavily blurred photo: no name, no member code, no contact, no
 *   exact age or birthday. The profile's own id is never published; the card has its own random `ref`.
 * - A visitor who likes a card leaves a name and a phone number proved with a text-message code: a lead for staff.
 */
const fail = (key: string) => ({ error: key });

export const DEFAULT_SHOWCASE_LIMIT = 12;
export const MAX_SHOWCASE_LIMIT = 24;

/** The card ages are shown in bands of this many years (a band of five hides the exact age). */
export const AGE_BAND = 5;

export interface ShowcaseSettings {
  enabled: boolean;
  limit: number;
}

export const showcaseSettingsSchema = z
  .object({
    enabled: z.boolean(fail('invalid')),
    limit: z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(MAX_SHOWCASE_LIMIT, fail('outOfRange')),
  })
  .strict();

/** Reads the stored value; anything missing or bad becomes "off" and the default size. */
export function parseShowcaseSettings(config: unknown): ShowcaseSettings {
  const raw =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).showcase
      : undefined;
  const stored =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const limit = showcaseSettingsSchema.shape.limit.safeParse(stored.limit);
  return {
    enabled: stored.enabled === true,
    limit: limit.success ? limit.data : DEFAULT_SHOWCASE_LIMIT,
  };
}

/** One card, as the public site shows it. */
export interface ShowcaseCard {
  ref: string;
  /** The age as a band such as 25 to 29, never the exact age. */
  ageBand: { min: number; max: number } | null;
  professionCode: string | null;
  districtCode: string | null;
  religionCode: string | null;
  /** The country the person lives in; Bangladesh when none was given. */
  countryCode: string;
  /** What the person says they look for, from their own partner preferences (a few words, no writing by staff). */
  wants: {
    ageMin: number | null;
    ageMax: number | null;
    educationMinCode: string | null;
    professionCodes: string[];
    districtCodes: string[];
    practiceCodes: string[];
  };
}

/** The age band of a person born on `birth`, on `today`. Null when the date is missing. */
export function ageBand(birth: string | null, today: Date): { min: number; max: number } | null {
  if (!birth) return null;
  const born = new Date(`${birth}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  let age = today.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < born.getUTCMonth() ||
    (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  if (age < 18) return null;
  const min = age - (age % AGE_BAND);
  return { min, max: min + AGE_BAND - 1 };
}

/** The filters of the browse page; a filter left out matches everyone. */
export interface BrowseFilter {
  district: string | null;
  religion: string | null;
  profession: string | null;
  country: string | null;
  ageMin: number | null;
  ageMax: number | null;
}

export const BROWSE_PAGE_SIZE = 12;

/** An empty value in the address counts as no filter. */
const blank = (value: unknown) => (value === '' || value === undefined ? undefined : value);
const code = (list: readonly string[]) =>
  z.preprocess(
    blank,
    z
      .string()
      .refine((v) => list.includes(v), fail('invalidOption'))
      .optional(),
  );
const ageParam = z.preprocess(
  blank,
  z.coerce.number(fail('invalid')).int().min(18).max(100).optional(),
);

export const browseQuerySchema = z.object({
  district: code(DISTRICTS),
  religion: code(RELIGIONS),
  profession: code(PROFESSIONS),
  country: code(COUNTRIES),
  ageMin: ageParam,
  ageMax: ageParam,
  page: z.preprocess(blank, z.coerce.number().int().min(1).max(200).default(1)),
});

/** A profile the admin may add, or has added: what staff need to recognise it (never published). */
export interface ShowcaseCandidate {
  profileId: string;
  memberCode: string;
  fullName: string;
  professionCode: string | null;
  districtCode: string | null;
  status: string;
  hidden: boolean;
  hasPhoto: boolean;
}

export const showcaseEntrySchema = z.object({ profileId: z.uuid(fail('invalid')) }).strict();

export const websiteVisibilitySchema = z.object({ hidden: z.boolean(fail('invalid')) }).strict();

/** A visitor asks for a code to prove their number. */
export const leadCodeInputSchema = z
  .object({ phone: phoneSchema, locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')) })
  .strict();

/** A visitor leaves their name and number, with the code they were sent. */
export const leadInputSchema = z
  .object({
    name: z.string(fail('required')).trim().min(2, fail('required')).max(80, fail('tooLong')),
    phone: phoneSchema,
    code: phoneCodeSchema,
    /** The card they were looking at; optional (they may just ask to be called). */
    ref: z.uuid(fail('invalid')).optional(),
  })
  .strict();
export type LeadInput = z.output<typeof leadInputSchema>;

/** A signed-in member tells their agent which card they liked. */
export const introductionRequestSchema = z
  .object({
    ref: z.uuid(fail('invalid')),
    note: z
      .string(fail('invalid'))
      .trim()
      .max(120, fail('tooLong'))
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
  })
  .strict();

export const LEAD_STATUSES = ['new', 'contacted', 'closed'] as const;
export const leadUpdateSchema = z
  .object({
    status: z.enum(LEAD_STATUSES, fail('invalidOption')),
    note: z
      .string(fail('invalid'))
      .trim()
      .max(500, fail('tooLong'))
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
  })
  .strict();

export interface Lead {
  id: string;
  name: string;
  phone: string;
  status: (typeof LEAD_STATUSES)[number];
  note: string | null;
  createdAt: string;
  /** The card the visitor was looking at, for staff: the member code and the profession. Null when they just asked to be called. */
  about: { profileId: string; memberCode: string; professionCode: string | null } | null;
}
