import { z } from 'zod';

/**
 * Private concerns (21 October 2026): a member tells the agency about a worry without their family seeing it.
 * Who reads it depends on what it is about (decided with the owner on 21 October 2026):
 *   - about the agency or its staff, or something else: only an admin, because it may be about an agent;
 *   - about a client's profile: an admin, and the agent who looks after that client, who is the one able to
 *     act. The agent does not see who reported it;
 *   - and, when the reporter ticks "my agent may read this too" (never for a concern about the staff), the
 *     reporter's own agent, who then sees who reported it.
 * Whoever reads it can write a short outcome the reporter can read. A concern is never edited or deleted.
 */
const fail = (key: string) => ({ error: key });

export const CONCERN_ABOUT = ['profile', 'agency', 'other'] as const;
export type ConcernAbout = (typeof CONCERN_ABOUT)[number];
export const CONCERN_CATEGORIES = [
  'fake_profile',
  'harassment',
  'asks_for_money',
  'photo_misuse',
  'dowry',
  'staff_conduct',
  'other',
] as const;
export type ConcernCategory = (typeof CONCERN_CATEGORIES)[number];

const message = z
  .string(fail('required'))
  .trim()
  .min(5, fail('tooShort'))
  .max(1500, fail('tooLong'));

export const concernInputSchema = z
  .object({
    about: z.enum(CONCERN_ABOUT, fail('invalidOption')),
    /** The profile it is about, when `about` is `profile`. */
    profileId: z.uuid(fail('invalid')).optional(),
    category: z.enum(CONCERN_CATEGORIES, fail('invalidOption')),
    message,
    /** Let the reporter's own agent read it too. Private by default; not allowed for a concern about the agency's staff. */
    shareWithMyAgent: z.boolean(fail('invalid')).default(false),
  })
  .strict()
  .refine((value) => (value.about === 'profile') === (value.profileId !== undefined), {
    path: ['profileId'],
    message: 'invalid',
  })
  .refine((value) => !(value.about === 'agency' && value.shareWithMyAgent), {
    path: ['shareWithMyAgent'],
    message: 'invalid',
  });
export type ConcernInput = z.output<typeof concernInputSchema>;

/** How a client with no login told the worry, when staff record it for them. */
export const TOLD_BY = ['phone', 'visit', 'family', 'other'] as const;
export type ToldBy = (typeof TOLD_BY)[number];

/**
 * A concern recorded by staff for a client with no login. The profile it is about is named by its member code, because
 * staff know it from the client. An agent may record only a concern about another member's profile; an admin may
 * record any.
 */
export const recordConcernSchema = z
  .object({
    about: z.enum(CONCERN_ABOUT, fail('invalidOption')),
    memberCode: z
      .string(fail('invalid'))
      .trim()
      .min(3, fail('tooShort'))
      .max(20, fail('tooLong'))
      .optional(),
    category: z.enum(CONCERN_CATEGORIES, fail('invalidOption')),
    message,
    toldBy: z.enum(TOLD_BY, fail('invalidOption')),
  })
  .strict()
  .refine((value) => (value.about === 'profile') === (value.memberCode !== undefined), {
    path: ['memberCode'],
    message: 'invalid',
  });
export type RecordConcernInput = z.output<typeof recordConcernSchema>;

export const resolveInputSchema = z
  .object({
    note: z.string(fail('required')).trim().min(3, fail('tooShort')).max(500, fail('tooLong')),
  })
  .strict();

export const concernListQuerySchema = z
  .object({ status: z.enum(['open', 'resolved'], fail('invalidOption')).default('open') })
  .strict();

/** What a reporter sees of their own concern: never who handled it. */
export interface MyConcern {
  id: string;
  about: ConcernAbout;
  /** The member code of the profile it is about, when there is one. */
  aboutCode: string | null;
  category: ConcernCategory;
  message: string;
  /** The reporter let their own agent read it. */
  sharedWithAgent: boolean;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
  outcomeNote: string | null;
}

/** What staff see of a concern. */
export interface ConcernRow extends MyConcern {
  /** Set when staff recorded it for a client with no login: who it was for, who recorded it and how it was told. */
  recorded: {
    forClient: { id: string; memberCode: string; fullName: string };
    by: string;
    toldBy: ToldBy;
  } | null;
  /** Who reported it. Null for an agent who is not the reporter's own agent (with the reporter's say-so). */
  reporter: { name: string; memberCode: string | null } | null;
  aboutProfile: { id: string; memberCode: string; fullName: string } | null;
  resolvedBy: string | null;
}
