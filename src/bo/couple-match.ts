import { z } from 'zod';

/**
 * The matched step (20 October 2026): the end of a successful search.
 *
 * Marking an accepted connection as matched, in one step:
 *   - records who did it, when, and a note;
 *   - moves both clients to `matched`, so they stop appearing to others, and withdraws their other
 *     waiting proposals (the people who asked are told);
 *   - sets the success fee each client agrees to pay (a record of what was agreed, like every fee here);
 *   - may start a success story: the names to show and a short text, which can be published only after
 *     both clients agreed (the staff member who talked with them records it).
 * An admin may do this for any connection. An agent may only when they look after both clients; with
 * two different agents it is an admin's step. A match can be undone (see undoMatchSchema) by the same people:
 * both clients go back to active, a published success story is hidden, and the record stays, marked undone.
 */
const fail = (key: string) => ({ error: key });

const localized = (max: number) =>
  z
    .object({
      bn: z.string().trim().max(max, fail('tooLong')).optional(),
      en: z.string().trim().max(max, fail('tooLong')).optional(),
    })
    .strict()
    .transform((value) => ({
      ...(value.bn ? { bn: value.bn } : {}),
      ...(value.en ? { en: value.en } : {}),
    }));

export const markMatchedSchema = z
  .object({
    note: z
      .string(fail('invalid'))
      .trim()
      .max(500, fail('tooLong'))
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
    /** The success fee each client agreed to, in whole taka. Left out: the agreement stays as it is. */
    fees: z
      .array(
        z
          .object({
            profileId: z.uuid(fail('invalid')),
            amount: z
              .number(fail('invalid'))
              .int(fail('invalid'))
              .min(0, fail('outOfRange'))
              .max(100_000_000, fail('outOfRange')),
          })
          .strict(),
      )
      .max(2, fail('tooLong'))
      .default([]),
    story: z
      .object({
        names: localized(120),
        text: localized(1500),
        year: z.number(fail('invalid')).int(fail('invalid')).min(1900).max(2100).optional(),
        /** The clients who agreed to a story. Both are needed before it can be published. */
        consentFrom: z
          .array(z.uuid(fail('invalid')))
          .max(2, fail('tooLong'))
          .default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MarkMatchedInput = z.output<typeof markMatchedSchema>;

export const storyStatusSchema = z
  .object({ status: z.enum(['published', 'hidden'], fail('invalidOption')) })
  .strict();

export interface StoryState {
  id: string;
  status: 'draft' | 'published' | 'hidden';
  /** Both clients agreed, so it may be published. */
  consentBoth: boolean;
}

/** Undoing a match needs a reason, which is kept with the record (the record itself is never deleted). */
export const undoMatchSchema = z
  .object({
    reason: z.string(fail('required')).trim().min(3, fail('tooShort')).max(500, fail('tooLong')),
  })
  .strict();
export type UndoMatchInput = z.output<typeof undoMatchSchema>;
