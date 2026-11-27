import { z } from 'zod';
import { MAX_BRANCHES } from './branch-slug.js';
import { memberCodeSchema } from './credentials.js';
import type { FollowUpState, LeadCall } from './lead-follow-up.js';
import { phoneCodeSchema } from './phone.js';
import { phoneSchema } from './phone-number.js';
import { REGISTRATION_LOCALES } from './registration.js';
import { LEAD_STATUSES } from './showcase.js';

/**
 * Talk to an adviser (21 November 2026, Shammo Bhai's guideline, his prototype and NavLume's lead traceability brief).
 *
 * - The public site shows the offices' addresses but no phone number. A visitor chooses what they want (talk on the
 *   phone, visit an office, WhatsApp), leaves a name and a mobile number and proves the number with a text-message
 *   code. Only then are they shown the branch's number (never a staff member's), and they can call, ask to be
 *   called, ask for an office visit at a part of the day, or open WhatsApp with their reference.
 * - When the code never arrives they can still leave a call request: it is kept unverified (no reference shown) and
 *   staff confirm it on the phone.
 * - An adviser (agent) is still chosen for every enquiry, so someone follows it up; the visitor is not told who.
 * - The lead is saved, with where the visitor came from, before any number is shown, so every digital enquiry
 *   leaves a record even when the person later walks into an office.
 * - The visitor gets a reference (for example 7KQ3-9XAB) to say at the office; staff find the lead by it.
 * - Where they came from is written once and never changed by staff.
 * - The same number coming back finds the same open enquiry (same reference, same adviser), not a new one.
 */
const fail = (key: string) => ({ error: key });

export const LEAD_SOURCES = [
  'qr',
  'google',
  'facebook',
  'whatsapp',
  'old_site',
  'other_site',
  'direct',
] as const;
/** The ad network whose own click id (fbclid, gclid) the landing address carried. */
export const CLICK_IDS = ['facebook', 'google'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const LEAD_KINDS = ['showcase', 'consultation'] as const;
/** What the visitor chose on the first screen. */
export const INTENTS = ['call', 'visit', 'whatsapp'] as const;
export type Intent = (typeof INTENTS)[number];
export const FOR_WHOM = ['self', 'child', 'relative', 'later'] as const;
export const VISIT_TIMES = ['morning', 'afternoon', 'any'] as const;
/** Where the visitor says they heard of the agency (optional; kept apart from where the browser says they came from). */
export const HEARD_FROM = [
  'facebook',
  'google',
  'youtube',
  'whatsapp',
  'friend',
  'event',
  'office',
  'other',
] as const;
export type HeardFrom = (typeof HEARD_FROM)[number];
/** What a verified visitor does next. */
export const ACTIONS = ['callback', 'call', 'visit', 'whatsapp'] as const;
export type Action = (typeof ACTIONS)[number];
/**
 * How a new enquiry starts: the number proved by a code (it gets a ticket), a call request without a proved number,
 * or only a code asked for (the code may never be typed).
 */
export type StartMode = 'verified' | 'callback' | 'code';

/** An open enquiry with the same number found within this many days is the same enquiry. */
export const REPEAT_WINDOW_DAYS = 90;

const short = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? undefined : value))
    .optional()
    .catch(undefined);

/**
 * What the browser remembered about the visitor's first arrival. Everything is optional and anything odd is dropped
 * rather than refused: a broken tracking value must never stop a person from reaching the agency.
 */
export const originSchema = z
  .object({
    utmSource: short(100),
    utmMedium: short(100),
    utmCampaign: short(100),
    utmContent: short(100),
    /** The full referrer the browser saw; only its host is kept. */
    referrer: short(2000),
    landingPath: short(300),
    firstSeenAt: z.iso.datetime().optional().catch(undefined),
    /** The landing address carried an ad network's click id (the id itself is never sent). */
    clickId: z.enum(CLICK_IDS).optional().catch(undefined),
  })
  .partial()
  .optional()
  .catch(undefined);
export type Origin = NonNullable<z.output<typeof originSchema>>;

const nameSchema = z
  .string(fail('required'))
  .trim()
  .min(2, fail('required'))
  .max(80, fail('tooLong'));

/** The enquiry's details, without the code. */
const detailsShape = {
  name: nameSchema,
  phone: phoneSchema,
  /** The position of the office the visitor chose in the agency's list (0 up to the most branches), if they chose one. */
  office: z
    .number()
    .int()
    .min(0)
    .max(MAX_BRANCHES - 1)
    .optional(),
  /** The showcase card they were looking at, if they came from one. */
  ref: z.uuid(fail('invalid')).optional(),
  intent: z.enum(INTENTS, fail('invalidOption')).default('call'),
  origin: originSchema,
  heardFrom: z.enum(HEARD_FROM, fail('invalidOption')).optional(),
  /**
   * The country the visitor lives in (ISO 3166 two letters). Bangladesh proves the mobile number by a text-message code;
   * anywhere else proves the email by a code (no text is sent abroad), so the email is then required.
   */
  country: z
    .string(fail('invalid'))
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, fail('invalid'))
    .default('BD'),
  /** A WhatsApp number an adviser may use, mostly for visitors abroad (optional, not proved). */
  whatsapp: z
    .string(fail('invalid'))
    .trim()
    .max(40, fail('tooLong'))
    .transform((value) => (value === '' ? undefined : value))
    .pipe(phoneSchema.optional())
    .optional(),
  /** An email address the visitor may leave beside the number (optional; an empty box is no address). */
  email: z
    .string(fail('invalid'))
    .trim()
    .toLowerCase()
    .max(254, fail('tooLong'))
    .transform((value) => (value === '' ? undefined : value))
    .pipe(z.email(fail('invalid')).optional())
    .optional(),
};

/**
 * Asking for a code. With the visitor's name (the site sends it) the enquiry is saved at once, before the code is
 * typed, so a visitor who never types it is still a lead. Without a name only the code is sent.
 */
export const consultationCodeSchema = z
  .object({
    ...detailsShape,
    name: nameSchema.optional(),
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
  })
  .strict();
export type ConsultationCodeInput = z.output<typeof consultationCodeSchema>;

export const consultationInputSchema = z
  .object({ ...detailsShape, code: phoneCodeSchema })
  .strict();
export type ConsultationInput = z.output<typeof consultationInputSchema>;

/** The code never arrived: the same details without a code, kept as an unverified call request. */
export const unverifiedInputSchema = z.object(detailsShape).strict();
export type UnverifiedInput = z.output<typeof unverifiedInputSchema>;

/** What a verified visitor does next, with the ticket their browser holds. */
export const consultationActionSchema = z
  .object({
    ticket: z.string(fail('invalid')).regex(/^[A-Za-z0-9_-]{32,64}$/, fail('invalid')),
    action: z.enum(ACTIONS, fail('invalidOption')),
    forWhom: z.enum(FOR_WHOM, fail('invalidOption')).optional(),
    /** For a visit request: the part of the day that suits them. */
    visitTime: z.enum(VISIT_TIMES, fail('invalidOption')).optional(),
  })
  .strict();
export type ConsultationAction = z.output<typeof consultationActionSchema>;

export const referenceSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/, fail('invalid'));

/** No 0, O, 1, I or L, so a reference read over the phone cannot be misheard as another. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A new reference from random bytes (at least 8). */
export function referenceFrom(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

/** A reference typed by staff ("abcd efgh", "ABCD-EFGH") in its stored form, or null when it cannot be one. */
export function typedReference(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== 8 || [...compact].some((char) => !ALPHABET.includes(char))) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** The host of a referrer address, lower case, without "www."; null when it is not a web address. */
export function referrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return (
      url.hostname
        .toLowerCase()
        .replace(/^www\./, '')
        .slice(0, 200) || null
    );
  } catch {
    return null;
  }
}

const GOOGLE = /(^|\.)google\.[a-z.]+$/;
const FACEBOOK = /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com)$/;

/** A host the admin typed (a bare domain or a full address), as referrerHost would read it; null when not a host. */
export function normaliseHost(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const host = referrerHost(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** Whether `host` is one of `hosts` or a subdomain of one. */
const within = (host: string, hosts: readonly string[]) =>
  hosts.some((own) => host === own || host.endsWith(`.${own}`));

/**
 * Where a visitor came from, read in this order:
 * 1. their campaign tags (a QR code carries utm_source=qr or ?src=qr-..., the old site's buttons utm_source=old_site,
 *    a link shared on WhatsApp utm_source=whatsapp; staff make these on the Links page, bo/campaign-link.ts);
 * 2. an ad network's own click id (fbclid, gclid), which survives a link someone forgot to tag;
 * 3. the referring site: Google, Facebook, the agency's old website (`oldSiteHosts`, set by the admin) or another.
 * `ownHost` is the agency's own site, so moving between its pages is not counted as a referral.
 */
export function sourceOf(
  origin: Origin | undefined,
  ownHost: string | null,
  oldSiteHosts: readonly string[] = [],
): LeadSource {
  const tag = `${origin?.utmSource ?? ''} ${origin?.utmMedium ?? ''}`.toLowerCase();
  if (/\bqr\b|qr[-_ ]?code/.test(tag)) return 'qr';
  if (/\bold[-_ ]?site\b/.test(tag)) return 'old_site';
  if (/\b(whatsapp|wa)\b/.test(tag)) return 'whatsapp';
  if (/\b(facebook|fb|instagram|ig|messenger|meta)\b/.test(tag)) return 'facebook';
  if (/\bgoogle\b/.test(tag)) return 'google';
  if (origin?.clickId) return origin.clickId;
  const host = referrerHost(origin?.referrer);
  if (host && host !== ownHost) {
    if (within(host, oldSiteHosts)) return 'old_site';
    if (GOOGLE.test(host)) return 'google';
    if (FACEBOOK.test(host)) return 'facebook';
    return 'other_site';
  }
  if (tag.trim()) return 'other_site';
  return 'direct';
}

/** The landing page without its query or fragment (a query can carry personal data). */
export function cleanPath(path: string | undefined): string | null {
  if (!path || !path.startsWith('/')) return null;
  return path.split(/[?#]/)[0]!.slice(0, 300) || null;
}

/** What the visitor sees once their number is proved. No staff member's name or number. */
export interface ConsultationResult {
  reference: string;
  /** The chosen branch's number, else the agency's. */
  officePhone: string | null;
  /** The secret the browser keeps for the next step. Shown once. */
  ticket: string;
  /** They had asked before with this number: the same enquiry. */
  returning: boolean;
  callbackRequested: boolean;
  visitRequested: boolean;
}

// ---- staff ------------------------------------------------------------------------------------------

export const staffLeadQuerySchema = z
  .object({
    status: z.enum(LEAD_STATUSES, fail('invalidOption')).optional(),
    source: z.enum(LEAD_SOURCES, fail('invalidOption')).optional(),
    q: z.string().trim().max(80).optional(),
    /** The campaign name of a staff-made link (utm_campaign): the enquiries it brought. */
    campaign: z.string().trim().max(100).optional(),
  })
  .strict();
export type StaffLeadQuery = z.output<typeof staffLeadQuerySchema>;

export const staffLeadUpdateSchema = z
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

export const leadAssignSchema = z.object({ agentId: z.uuid(fail('invalid')) }).strict();

/**
 * At the office, before a new client is added: find the website enquiry they made, by its reference (with or without
 * the dash) or by the full mobile number. Exact matches only, so it cannot be used to browse other people's enquiries.
 */
export const leadLookupQuerySchema = z
  .object({ q: z.string(fail('invalid')).trim().min(4, fail('tooShort')).max(40, fail('tooLong')) })
  .strict();

/** What the office needs to recognise an enquiry and join the new client to it. */
export interface LeadMatch {
  id: string;
  reference: string | null;
  name: string;
  phone: string;
  createdAt: string;
  source: LeadSource | null;
  campaign: string | null;
  adviser: string | null;
  /** Already joined to a client (then it is shown, not offered). */
  clientCode: string | null;
}

/** Staff link an enquiry to a client by member code (when the client registered with another number). */
export const leadLinkSchema = z.object({ memberCode: memberCodeSchema }).strict();

/** One enquiry as staff read it. */
export interface StaffLead {
  id: string;
  kind: (typeof LEAD_KINDS)[number];
  reference: string | null;
  name: string;
  phone: string;
  /** The email address the visitor left, if any. */
  email: string | null;
  /** When the email was proved by a code (visitors abroad); null otherwise. */
  emailVerifiedAt: string | null;
  /** The country the visitor chose (two letters); null for enquiries made before the choice existed. */
  country: string | null;
  /** A WhatsApp number the visitor left, not proved. */
  whatsapp: string | null;
  status: (typeof LEAD_STATUSES)[number];
  note: string | null;
  createdAt: string;
  lastVerifiedAt: string | null;
  visits: number;
  office: string | null;
  intent: Intent | null;
  forWhom: (typeof FOR_WHOM)[number] | null;
  /** What the visitor said about where they heard of the agency. */
  heardFrom: HeardFrom | null;
  /** When the number was first proved; null for an unverified call request or a code never typed. */
  verifiedAt: string | null;
  /** When a code was last asked for. With no verifiedAt and no callbackRequestedAt: a code never typed. */
  codeSentAt: string | null;
  callbackRequestedAt: string | null;
  callClickedAt: string | null;
  visitRequestedAt: string | null;
  visitTime: (typeof VISIT_TIMES)[number] | null;
  whatsappOpenedAt: string | null;
  adviser: { id: string; name: string } | null;
  handledBy: string | null;
  handledAt: string | null;
  origin: {
    source: LeadSource | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmContent: string | null;
    referrerHost: string | null;
    landingPath: string | null;
    firstSeenAt: string | null;
    clickId: (typeof CLICK_IDS)[number] | null;
  };
  /** The showcase card they asked about. */
  about: { profileId: string; memberCode: string } | null;
  /**
   * The client this enquiry became: found by its mobile number (`auto`) or chosen by staff by member code (`staff`).
   * `createdAt` is the profile's own creation, so the order of enquiry and client can be shown.
   */
  client: {
    profileId: string;
    memberCode: string;
    name: string | null;
    createdAt: string;
    linkedAt: string;
    method: 'auto' | 'staff';
    linkedBy: string | null;
  } | null;
  /** Not linked yet: how many clients have this number (2 or more: staff choose, nothing is linked automatically). */
  phoneMatches: number;
  /** The first call written down, or the first move away from "new". */
  firstContactAt: string | null;
  /** Against the agency's time limit for the first call (office hours). */
  followUp: { state: FollowUpState; dueAt: string | null };
  /** The calls written down, newest first (at most 20). */
  calls: LeadCall[];
}
