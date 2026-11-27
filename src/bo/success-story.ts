import { z } from 'zod';
import { localized } from './couple-match.js';
import { weddingDateSchema } from './site-content.js';

/**
 * Success stories added by hand (27 November 2026, migration 071).
 *
 * The agency has more than twelve years of real couples from before the website. An admin adds their story directly,
 * without a match on the platform: names and words in Bengali and English, a wedding date or year, and a couple photo
 * (the same photo pipeline as a match story). Such a story is published only after the admin records that the couple
 * gave permission, with a short note of how and when (for example "written permission from both, 20 Nov 2026"). It may
 * be saved as a draft without one. Publishing, hiding, the photo and removal are the same as for a match story.
 */
const fail = (key: string) => ({ error: key });

/** How the couple's permission was given, recorded by the admin. Null: not given (yet). */
const consentSchema = z
  .object({
    note: z.string(fail('required')).trim().min(5, fail('tooShort')).max(300, fail('tooLong')),
  })
  .strict()
  .nullable()
  .default(null);

const storyFields = {
  names: localized(120).refine((names) => Boolean(names.bn || names.en), fail('required')),
  text: localized(1500).default({}),
  year: z.number(fail('invalid')).int(fail('invalid')).min(1900).max(2100).nullable().default(null),
  weddingDate: weddingDateSchema.shape.weddingDate.default(null),
  consent: consentSchema,
};

/** A new story; `publish` puts it on the site at once, which needs the couple's permission. */
export const manualStoryCreateSchema = z
  .object({ ...storyFields, publish: z.boolean(fail('invalid')).default(false) })
  .strict();
export type ManualStoryCreateInput = z.output<typeof manualStoryCreateSchema>;

/** The whole story again (names, words, date, year and permission); the photo and status have their own calls. */
export const manualStoryUpdateSchema = z.object(storyFields).strict();
export type ManualStoryUpdateInput = z.output<typeof manualStoryUpdateSchema>;

/** The most stories the admin's list returns (newest first). */
export const MAX_ADMIN_STORIES = 500;

/** One story in the admin's list, from a match or added by hand. */
export interface AdminStory {
  id: string;
  source: 'match' | 'manual';
  names: { bn?: string; en?: string };
  story: { bn?: string; en?: string } | null;
  year: number | null;
  /** `YYYY-MM-DD`. */
  weddingDate: string | null;
  status: 'draft' | 'published' | 'hidden';
  /** The consent the source needs is there, so it may be published: both clients for a match, the admin's record by hand. */
  canPublish: boolean;
  /** How the couple gave permission (stories added by hand only). */
  consentNote: string | null;
  consentRecordedAt: string | null;
  hasPhoto: boolean;
  removed: boolean;
  createdAt: string;
  publishedAt: string | null;
}
