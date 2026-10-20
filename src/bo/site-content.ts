import { z } from 'zod';
import { HOME_SECTION_IDS, THEME_IDS } from './public-config.js';

/**
 * The words of an agency's public site that its admin edits from the dashboard (20 October 2026):
 * contact details, the home page's title and subtitle, the about text and up to three branches.
 * They are stored inside the agency's `public_config`; its name, colours and logo stay operator-set,
 * and the success stories come from the matched step (published ones are added when the site is
 * served, see SiteContentService). A field left empty is removed so the site falls back to its
 * default words.
 */
const fail = (key: string) => ({ error: key });

const clean = (max: number) =>
  z
    .string(fail('invalid'))
    .trim()
    .max(max, fail('tooLong'))
    .transform((value) => (value === '' ? undefined : value))
    .optional();

const localized = (max: number) =>
  z
    .object({ bn: clean(max), en: clean(max) })
    .strict()
    .optional()
    .transform((value) => (value && (value.bn || value.en) ? value : undefined));

const httpsUrl = z
  .string(fail('invalid'))
  .trim()
  .max(2000, fail('tooLong'))
  .transform((value) => (value === '' ? undefined : value))
  .refine((value) => {
    if (value === undefined) return true;
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, fail('invalid'))
  .optional();

const email = z
  .string(fail('invalid'))
  .trim()
  .max(200, fail('tooLong'))
  .transform((value) => (value === '' ? undefined : value))
  .refine(
    (value) => value === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    fail('invalid'),
  )
  .optional();

const branch = z
  .object({
    name: localized(120),
    address: localized(300),
    phone: clean(40),
    mapUrl: httpsUrl,
  })
  .strict()
  .refine((value) => value.name !== undefined, fail('required'));

const homeSectionInput = z
  .object({
    id: z.enum(HOME_SECTION_IDS),
    visible: z.boolean().optional(),
    title: localized(160),
    text: localized(400),
    items: z
      .array(z.object({ title: localized(160), text: localized(400) }).strict())
      .max(4, fail('tooMany'))
      .optional(),
  })
  .strict();

export const siteContentSchema = z
  .object({
    contact: z
      .object({ phone: clean(40), email })
      .strict()
      .optional(),
    home: z
      .object({
        title: localized(120),
        subtitle: localized(300),
        sections: z
          .array(homeSectionInput)
          .max(HOME_SECTION_IDS.length, fail('tooMany'))
          .refine((list) => new Set(list.map((s) => s.id)).size === list.length, fail('duplicate'))
          .optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({ headline: localized(120), text: localized(300), scene: z.boolean().optional() })
      .strict()
      .optional(),
    about: localized(4000),
    branches: z.array(branch).max(3, fail('tooMany')).optional(),
  })
  .strict();
export type SiteContentInput = z.output<typeof siteContentSchema>;

/** What the dashboard edits: the same four parts, as stored. */
export interface SiteContent {
  contact: { phone?: string; email?: string };
  home: {
    title?: { bn?: string; en?: string };
    subtitle?: { bn?: string; en?: string };
    sections?: unknown[];
  };
  /** The words of the sign-in and registration pages' side panel, and whether the village scene shows. */
  auth: {
    headline?: { bn?: string; en?: string };
    text?: { bn?: string; en?: string };
    scene?: boolean;
  };
  about?: { bn?: string; en?: string };
  branches: {
    name?: { bn?: string; en?: string };
    address?: { bn?: string; en?: string };
    phone?: string;
    mapUrl?: string;
  }[];
  /** The agency's look as stored; the name falls back to the agency's own name. */
  branding: {
    name: string;
    primaryColor?: string;
    accentColor?: string;
    theme?: string;
    logoUrl?: string;
  };
  /** How many published success stories the site shows (they are published from Reports). */
  publishedStories: number;
}

/**
 * The agency's look, edited by its admin (20 October 2026): the name shown on the site, the main colour
 * and the logo. The colour reaches CSS and is used both as a background under white text and as text on
 * white, so it must be dark enough for white to be read on it (the usual 4.5 to 1 contrast); a pale colour
 * is refused with `tooLight`. An empty name or colour is removed, so the platform's own take over.
 */
const emptyToUndefined = (value: string) => (value.trim() === '' ? undefined : value.trim());

export const brandingSchema = z
  .object({
    name: z
      .string(fail('invalid'))
      .max(200, fail('tooLong'))
      .transform(emptyToUndefined)
      .optional(),
    primaryColor: z
      .string(fail('invalid'))
      .transform(emptyToUndefined)
      .refine((value) => value === undefined || /^#[0-9a-fA-F]{6}$/.test(value), fail('invalid'))
      .refine((value) => value === undefined || contrastOnWhite(value) >= 4.5, fail('tooLight'))
      .optional(),
    /** The second colour of the look (gold in the classic one). Dark text is put on it, so it must be light enough. */
    accentColor: z
      .string(fail('invalid'))
      .transform(emptyToUndefined)
      .refine((value) => value === undefined || /^#[0-9a-fA-F]{6}$/.test(value), fail('invalid'))
      .refine((value) => value === undefined || contrastOnDark(value) >= 4.5, fail('tooDark'))
      .optional(),
    theme: z.enum(THEME_IDS, fail('invalidOption')).optional(),
  })
  .strict();
export type BrandingInput = z.output<typeof brandingSchema>;

/** WCAG contrast of a `#RRGGBB` colour against near-black text (#111111). */
export function contrastOnDark(hex: string): number {
  return (relativeLuminance(hex) + 0.05) / 0.0556;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast of a `#RRGGBB` colour against white. */
export function contrastOnWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}

/** The name of a stored logo file: one random id, always WebP. */
export const LOGO_FILE =
  /^logo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
