import { z } from 'zod';
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

export const settingsInputSchema = z
  .object({ attention: attentionLimitsSchema, messaging: messagingSettingsSchema })
  .strict();
export type SettingsInput = z.output<typeof settingsInputSchema>;

export interface AgencySettings {
  attention: AttentionLimits;
  messaging: MessagingSettings;
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
  return {
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
