import { z } from 'zod';
import { normaliseHost } from './consultation.js';
import {
  DEFAULT_FOLLOW_UP_HOURS,
  MAX_FOLLOW_UP_HOURS,
  MIN_FOLLOW_UP_HOURS,
} from './lead-follow-up.js';
import {
  DEFAULT_DAILY_LIMIT,
  DEFAULT_PER_MEMBER_DAILY,
  MAX_DAILY_LIMIT,
  MAX_PER_MEMBER_DAILY,
} from './messaging.js';

/**
 * An agency's own settings (21 October 2026), set by its admin. Today: after how many days each kind of
 * waiting item counts as overdue on the agenda. They are kept as one JSON value on the agency, read leniently
 * (a missing or invalid number falls back to the default), and every field has a sensible range.
 */
const fail = (key: string) => ({ error: key });

export const ATTENTION_DEFAULTS = {
  /** A profile, photo, CV, identity document or request waiting for a decision. */
  reviewDays: 2,
  /** An approved request the person asked has not answered. */
  unansweredDays: 5,
  /** A published client with an agent and no profile released. */
  noCandidatesDays: 3,
  /** An accepted request with no meeting arranged and no match. */
  noMeetingDays: 7,
} as const;

export const MIN_DAYS = 1;
export const MAX_DAYS = 60;

const days = z
  .number(fail('invalid'))
  .int(fail('invalid'))
  .min(MIN_DAYS, fail('outOfRange'))
  .max(MAX_DAYS, fail('outOfRange'));

export const attentionLimitsSchema = z
  .object({
    reviewDays: days,
    unansweredDays: days,
    noCandidatesDays: days,
    noMeetingDays: days,
  })
  .strict();
export type AttentionLimits = z.output<typeof attentionLimitsSchema>;

/**
 * Texts outside the app. Off unless the agency's admin turns them on, because every text costs money. When on, the
 * most the agency sends in a day (zero sends none).
 */
export const messagingSettingsSchema = z
  .object({
    enabled: z.boolean(fail('invalid')),
    /** The most texts one member gets in a day; further lines stay in the app inbox. */
    perMemberDaily: z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(MAX_PER_MEMBER_DAILY, fail('outOfRange')),
    dailyLimit: z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(0, fail('outOfRange'))
      .max(MAX_DAILY_LIMIT, fail('outOfRange')),
  })
  .strict();
export type MessagingSettings = z.output<typeof messagingSettingsSchema>;

/**
 * How a new client gets an agent. Automatic (the default): the platform gives the profile to the active agent with
 * the fewest clients, the moment it is created. Manual: it starts with no agent and an admin chooses one from the
 * list of clients nobody looks after; the client is told so, and told who once an admin has chosen.
 */
export const ASSIGNMENT_MODES = ['automatic', 'manual'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];
export const DEFAULT_ASSIGNMENT_MODE: AssignmentMode = 'automatic';

export const assignmentSettingsSchema = z
  .object({ mode: z.enum(ASSIGNMENT_MODES, fail('invalid')) })
  .strict();
export type AssignmentSettings = z.output<typeof assignmentSettingsSchema>;

/**
 * Leads (21 November 2026): the addresses of the agency's old website, so a visitor who clicks through from it is
 * counted as coming from the old site even when the link carries no tag. Typed as domains or full addresses; kept
 * as bare hosts without "www.". And how many office hours staff have to call a new enquiry (default 2).
 */
export const MAX_OLD_SITE_HOSTS = 5;
export const leadSettingsSchema = z
  .object({
    oldSiteHosts: z
      .array(
        z
          .string(fail('invalid'))
          .max(200, fail('tooLong'))
          .transform((value, ctx) => {
            const host = normaliseHost(value);
            if (!host) ctx.addIssue({ code: 'custom', message: 'invalid' });
            return host ?? '';
          }),
        fail('invalid'),
      )
      .max(MAX_OLD_SITE_HOSTS, fail('outOfRange'))
      .transform((hosts) => [...new Set(hosts)])
      .optional(),
    followUpHours: z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(MIN_FOLLOW_UP_HOURS, fail('outOfRange'))
      .max(MAX_FOLLOW_UP_HOURS, fail('outOfRange'))
      .optional(),
  })
  .strict();
/** Each part is optional when saving: a part left out keeps what is stored. */
export type LeadSettingsInput = z.output<typeof leadSettingsSchema>;
export interface LeadSettings {
  oldSiteHosts: string[];
  followUpHours: number;
}

export const settingsInputSchema = z
  .object({
    attention: attentionLimitsSchema,
    messaging: messagingSettingsSchema,
    assignment: assignmentSettingsSchema,
    /** Optional so an older page that does not know it keeps what is stored. */
    leads: leadSettingsSchema.optional(),
  })
  .strict();
export type SettingsInput = z.output<typeof settingsInputSchema>;

export interface AgencySettings {
  attention: AttentionLimits;
  messaging: MessagingSettings;
  assignment: AssignmentSettings;
  leads: LeadSettings;
}

const lenient = (value: unknown, fallback: number) => {
  const parsed = days.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

/** Reads the stored value: anything missing or out of range becomes the default, so a bad value never breaks a page. */
export function parseSettings(raw: unknown): AgencySettings {
  const stored =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).attention as Record<string, unknown> | undefined)
      : undefined;
  const at = stored && typeof stored === 'object' ? stored : {};
  const messagingRaw =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).messaging
      : undefined;
  const stored2 =
    messagingRaw && typeof messagingRaw === 'object' && !Array.isArray(messagingRaw)
      ? (messagingRaw as Record<string, unknown>)
      : {};
  const limit = messagingSettingsSchema.shape.dailyLimit.safeParse(stored2.dailyLimit);
  const perMember = messagingSettingsSchema.shape.perMemberDaily.safeParse(stored2.perMemberDaily);
  const assignmentRaw =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).assignment
      : undefined;
  const mode = assignmentSettingsSchema.shape.mode.safeParse(
    assignmentRaw && typeof assignmentRaw === 'object'
      ? (assignmentRaw as Record<string, unknown>).mode
      : undefined,
  );
  const leadsRaw =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).leads
      : undefined;
  const hostsRaw =
    leadsRaw && typeof leadsRaw === 'object'
      ? (leadsRaw as Record<string, unknown>).oldSiteHosts
      : undefined;
  const oldSiteHosts = Array.isArray(hostsRaw)
    ? [
        ...new Set(
          hostsRaw
            .map((value) => (typeof value === 'string' ? normaliseHost(value) : null))
            .filter((host): host is string => host !== null),
        ),
      ].slice(0, MAX_OLD_SITE_HOSTS)
    : [];
  const hours = leadSettingsSchema.shape.followUpHours.safeParse(
    leadsRaw && typeof leadsRaw === 'object'
      ? (leadsRaw as Record<string, unknown>).followUpHours
      : undefined,
  );
  return {
    leads: { oldSiteHosts, followUpHours: hours.data ?? DEFAULT_FOLLOW_UP_HOURS },
    assignment: { mode: mode.success ? mode.data : DEFAULT_ASSIGNMENT_MODE },
    messaging: {
      enabled: stored2.enabled === true,
      dailyLimit: limit.success ? limit.data : DEFAULT_DAILY_LIMIT,
      perMemberDaily: perMember.success ? perMember.data : DEFAULT_PER_MEMBER_DAILY,
    },
    attention: {
      reviewDays: lenient(at.reviewDays, ATTENTION_DEFAULTS.reviewDays),
      unansweredDays: lenient(at.unansweredDays, ATTENTION_DEFAULTS.unansweredDays),
      noCandidatesDays: lenient(at.noCandidatesDays, ATTENTION_DEFAULTS.noCandidatesDays),
      noMeetingDays: lenient(at.noMeetingDays, ATTENTION_DEFAULTS.noMeetingDays),
    },
  };
}
