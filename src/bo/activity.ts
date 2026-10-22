import { z } from 'zod';

/**
 * The activity log (20 October 2026): what happened in the agency, who did it and when, for admins.
 * It reads the event log that every important change already writes to, so nothing new is recorded;
 * this only lets an admin read it. Read only, admins only.
 */
const fail = (key: string) => ({ error: key });

/** The kinds of events an admin can narrow the log to, by the first part of the event's name. */
export const ACTIVITY_GROUPS = {
  signins: ['auth'],
  people: ['account', 'staff', 'client'],
  profiles: ['profile', 'cv', 'photo', 'verification', 'candidates'],
  proposals: ['interest', 'match', 'story'],
  meetings: ['meeting', 'note', 'followup'],
  payments: ['payment', 'service_terms'],
  safety: ['concern', 'flag'],
  chats: ['chat'],
  guardians: ['guardian'],
  site: ['site', 'legal', 'agreements', 'settings'],
} as const;
export type ActivityGroup = keyof typeof ACTIVITY_GROUPS;
/** Everything except sign-ins, which are many and rarely what an admin looks for. */
export const DEFAULT_PREFIXES = Object.entries(ACTIVITY_GROUPS)
  .filter(([group]) => group !== 'signins')
  .flatMap(([, prefixes]) => prefixes as readonly string[]);

const day = z
  .string(fail('invalid'))
  .regex(/^\d{4}-\d{2}-\d{2}$/, fail('invalid'))
  .optional();

export const activityQuerySchema = z
  .object({
    group: z
      .enum(
        Object.keys(ACTIVITY_GROUPS) as [ActivityGroup, ...ActivityGroup[]],
        fail('invalidOption'),
      )
      .optional(),
    /** Part of the name of the person who did it. */
    q: z.string().trim().min(1, fail('required')).max(60, fail('tooLong')).optional(),
    from: day,
    to: day,
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(100, fail('outOfRange'))
      .default(30),
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type ActivityQuery = z.output<typeof activityQuerySchema>;

export interface ActivityItem {
  id: string;
  /** The event's name, such as `payment.voided`; the screen turns it into words. */
  type: string;
  at: string;
  actor: { id: string; name: string; role: string } | null;
  /** What it was about, in words when it can be told (a client, a couple, an account). */
  subject: string | null;
  /** The client the event was about, when it was about one, so the screen can link to them. */
  profileId: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  next: string | null;
}
