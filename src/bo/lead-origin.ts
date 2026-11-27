import { z } from 'zod';

/** The ad network whose own click id (fbclid, gclid) the landing address carried. */
export const CLICK_IDS = ['facebook', 'google'] as const;

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
 * rather than refused: a broken tracking value must never stop a person from reaching the agency. Shared by the
 * adviser enquiry and registration, which both keep where a lead came from.
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
