import { z } from 'zod';

/**
 * Following up website enquiries (21 November 2026, owner decision): staff try to call every enquiry within a time
 * limit the admin sets (default 2 hours), counted in office hours, Bangladesh time. When it passes with no call written
 * down, the agent is reminded; when a second limit passes too, the admins are told.
 *
 * Office hours are fixed for now (10:00 to 20:00, every day); a setting can come when an agency needs other hours.
 */
const fail = (key: string) => ({ error: key });

export const DEFAULT_FOLLOW_UP_HOURS = 2;
export const MIN_FOLLOW_UP_HOURS = 1;
export const MAX_FOLLOW_UP_HOURS = 48;
export const OFFICE_OPEN_HOUR = 10;
export const OFFICE_CLOSE_HOUR = 20;

/** Bangladesh has no daylight saving: always UTC+6. */
const BD_OFFSET_MS = 6 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The moment `hours` of office time have passed after `start`. An enquiry left at night starts counting when the
 * office opens: one left at 23:00 with a 2-hour limit is due at 12:00 the next day.
 */
export function followUpDue(start: Date, hours: number): Date {
  // A broken date or limit must never spin the loop below.
  if (!Number.isFinite(start.getTime()) || !(hours > 0)) return start;
  // Work in Bangladesh wall-clock time, as milliseconds.
  let t = start.getTime() + BD_OFFSET_MS;
  let remaining = hours * HOUR_MS;
  for (;;) {
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
    const open = dayStart + OFFICE_OPEN_HOUR * HOUR_MS;
    const close = dayStart + OFFICE_CLOSE_HOUR * HOUR_MS;
    if (t < open) t = open;
    if (t >= close) {
      t = open + DAY_MS;
      continue;
    }
    if (remaining <= close - t) return new Date(t + remaining - BD_OFFSET_MS);
    remaining -= close - t;
    t = open + DAY_MS;
  }
}

/** Where an enquiry stands against the limit, for staff. */
export type FollowUpState = 'contacted' | 'waiting' | 'overdue' | 'escalated';

export function followUpState(
  lead: { createdAt: Date; firstContactAt: Date | null; status: string },
  hours: number,
  now: Date,
): { state: FollowUpState; dueAt: Date | null } {
  if (lead.firstContactAt || lead.status !== 'new') return { state: 'contacted', dueAt: null };
  const dueAt = followUpDue(lead.createdAt, hours);
  if (now < dueAt) return { state: 'waiting', dueAt };
  return { state: now < followUpDue(dueAt, hours) ? 'overdue' : 'escalated', dueAt };
}

// ---- calls ---------------------------------------------------------------------------------------

export const CALL_OUTCOMES = [
  'no_answer',
  'interested',
  'not_interested',
  'call_later',
  'visit_booked',
  'wrong_number',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** A call staff write down. "Call me later" may carry when; nothing else does. */
export const leadCallSchema = z
  .object({
    outcome: z.enum(CALL_OUTCOMES, fail('invalidOption')),
    note: z
      .string(fail('invalid'))
      .trim()
      .max(500, fail('tooLong'))
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
    callAgainAt: z.iso.datetime(fail('invalid')).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.callAgainAt && value.outcome !== 'call_later')
      ctx.addIssue({ code: 'custom', path: ['callAgainAt'], message: 'invalid' });
  });
export type LeadCallInput = z.output<typeof leadCallSchema>;

export interface LeadCall {
  id: string;
  outcome: CallOutcome;
  note: string | null;
  callAgainAt: string | null;
  calledBy: string | null;
  calledAt: string;
}
