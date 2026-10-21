import { z } from 'zod';
import { declineReasonSchema, type DeclineReason } from './decline.js';

/**
 * Meetings, private notes and follow-ups (17 October 2026).
 *
 * - A meeting belongs to an accepted proposal. Staff who look after either side set it (when, where,
 *   what kind), change it, cancel it or mark it done. Both people are told when it is set or changed.
 * - After a meeting is done, the staff of each side record what that side said (interested, undecided,
 *   not interested). That feedback stays in the office: a client never sees it, and neither side's
 *   agent sees the other side's.
 * - A note is private to staff and is never changed or deleted. A follow-up is a reminder with a due
 *   day for the agent who looks after the client; it is marked done, never deleted.
 */
const fail = (key: string) => ({ error: key });

export const MEETING_KINDS = ['first_meeting', 'family_meeting', 'visit', 'call', 'other'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];
export const MEETING_STATUSES = ['proposed', 'scheduled', 'done', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export const VERDICTS = ['interested', 'undecided', 'not_interested'] as const;
export type Verdict = (typeof VERDICTS)[number];

const text = (max: number) =>
  z
    .string(fail('invalid'))
    .trim()
    .max(max, fail('tooLong'))
    .transform((value) => (value === '' ? undefined : value))
    .optional();
const when = z.iso.datetime({ offset: true, error: 'invalid' });

export const meetingInputSchema = z
  .object({
    scheduledAt: when,
    kind: z.enum(MEETING_KINDS, fail('invalidOption')),
    place: text(200),
    note: text(500),
  })
  .strict();
export type MeetingInput = z.output<typeof meetingInputSchema>;

/** A change to a meeting. Only what is given changes; `place` and `note` may be cleared with null. */
export const meetingPatchSchema = z
  .object({
    scheduledAt: when.optional(),
    kind: z.enum(MEETING_KINDS, fail('invalidOption')).optional(),
    place: z.union([text(200), z.null()]).optional(),
    note: z.union([text(500), z.null()]).optional(),
    status: z.enum(['done', 'cancelled'], fail('invalidOption')).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'invalid' });
export type MeetingPatch = z.output<typeof meetingPatchSchema>;

/** The other side suggests another time for a proposed meeting. */
export const suggestInputSchema = z.object({ scheduledAt: when }).strict();

export const feedbackInputSchema = z
  .object({
    verdict: z.enum(VERDICTS, fail('invalidOption')),
    note: text(500),
    /** Why, when the verdict is not interested. Optional and private to the agency (see bo/decline.ts). */
    reason: declineReasonSchema.optional(),
  })
  .strict()
  .refine((value) => value.reason === undefined || value.verdict === 'not_interested', {
    path: ['reason'],
    message: 'invalid',
  });
export type FeedbackInput = z.output<typeof feedbackInputSchema>;

export const noteInputSchema = z
  .object({
    body: z.string(fail('required')).trim().min(1, fail('required')).max(1000, fail('tooLong')),
  })
  .strict();

export const followUpInputSchema = z
  .object({
    dueOn: z.string(fail('invalid')).regex(/^\d{4}-\d{2}-\d{2}$/, fail('invalid')),
    text: z.string(fail('required')).trim().min(1, fail('required')).max(200, fail('tooLong')),
  })
  .strict();
export type FollowUpInput = z.output<typeof followUpInputSchema>;

export interface MeetingFeedback {
  verdict: Verdict;
  note: string | null;
  /** Why the client was not interested, from the pick-list, when it was given. */
  reason: DeclineReason | null;
  recordedAt: string;
}

export interface MeetingPerson {
  profileId: string;
  memberCode: string;
  fullName: string;
  /** The staff member looks after this side. Only then is its feedback shown or recorded. */
  managed: boolean;
  feedback: MeetingFeedback | null;
}

/** A meeting as staff see it. */
export interface MeetingRow {
  id: string;
  connectionId: string;
  scheduledAt: string;
  kind: MeetingKind;
  place: string | null;
  note: string | null;
  status: MeetingStatus;
  createdBy: string;
  /** Still marked scheduled although its time has passed: the outcome is missing. */
  awaitingOutcome: boolean;
  /** Proposed by one side: the staff member (or an admin) may confirm it or suggest another time. */
  canRespond: boolean;
  people: [MeetingPerson, MeetingPerson];
}

/** A meeting as a client sees it: when and where, with the other person. Never feedback or notes. */
export interface MemberMeeting {
  id: string;
  /** Proposed by the other side: the client may confirm it or suggest another time. */
  canRespond: boolean;
  scheduledAt: string;
  kind: MeetingKind;
  place: string | null;
  note: string | null;
  status: MeetingStatus;
  other: { profileId: string; memberCode: string; fullName: string };
}

export interface NoteRow {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface FollowUpRow {
  id: string;
  profile: { id: string; memberCode: string; fullName: string };
  dueOn: string;
  text: string;
  assignedTo: string;
  /** Due today or earlier (Bangladesh time) and not done. */
  due: boolean;
  done: { at: string; by: string } | null;
}

export interface Agenda {
  meetings: MeetingRow[];
  followUps: FollowUpRow[];
  /** Overdue follow-ups plus meetings still waiting for an outcome: the badge number. */
  attention: number;
}
