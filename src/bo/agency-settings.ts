import { z } from 'zod';

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

export const settingsInputSchema = z.object({ attention: attentionLimitsSchema }).strict();
export type SettingsInput = z.output<typeof settingsInputSchema>;

export interface AgencySettings {
  attention: AttentionLimits;
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
  return {
    attention: {
      reviewDays: lenient(at.reviewDays, ATTENTION_DEFAULTS.reviewDays),
      unansweredDays: lenient(at.unansweredDays, ATTENTION_DEFAULTS.unansweredDays),
      noCandidatesDays: lenient(at.noCandidatesDays, ATTENTION_DEFAULTS.noCandidatesDays),
      noMeetingDays: lenient(at.noMeetingDays, ATTENTION_DEFAULTS.noMeetingDays),
    },
  };
}
