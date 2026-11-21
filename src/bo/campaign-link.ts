import { z } from 'zod';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * Tagged links and QR codes made by staff (21 November 2026, lead capture phase A step 3).
 *
 * Every place the agency puts a link gets its own link, so the enquiries it brings can be told apart and counted.
 * Staff choose where the link will go and give it a name; the platform makes the tags (nobody types them) and a
 * campaign name (`slug`) from the name. The link opens "Talk to an adviser"; an office QR code also preselects the
 * office. Agents and admins may make links (owner decision); an admin or the person who made a link may put it away.
 * A link put away keeps working: printed QR codes cannot be taken back.
 */
const fail = (key: string) => ({ error: key });

export const LINK_KINDS = [
  'facebook_ad',
  'facebook_post',
  'whatsapp',
  'old_site',
  'event_qr',
  'office_qr',
  'other',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** The tags each kind of link carries; read back by `sourceOf` (bo/consultation.ts) as the lead's source. */
export const LINK_TAGS: Record<LinkKind, { source: string; medium: string }> = {
  facebook_ad: { source: 'facebook', medium: 'ad' },
  facebook_post: { source: 'facebook', medium: 'post' },
  whatsapp: { source: 'whatsapp', medium: 'share' },
  old_site: { source: 'old_site', medium: 'button' },
  event_qr: { source: 'qr', medium: 'event' },
  office_qr: { source: 'qr', medium: 'office' },
  other: { source: 'link', medium: 'other' },
};

export const MAX_SLUG = 60;

/**
 * A campaign name from what staff typed: lower-case Latin letters and digits joined by dashes. A name in Bangla
 * (or anything with no Latin letters) gives an empty slug; the caller then makes one from the kind.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG - 6)
    .replace(/-+$/g, '');
}

export const campaignLinkInputSchema = z
  .object({
    kind: z.enum(LINK_KINDS, fail('invalidOption')),
    name: z.string(fail('required')).trim().min(2, fail('required')).max(80, fail('tooLong')),
    /** For an office QR code: the office's position in the agency's list. */
    office: z.number(fail('invalid')).int().min(0).max(2).optional(),
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')).default('bn'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === 'office_qr') !== (value.office !== undefined))
      ctx.addIssue({ code: 'custom', path: ['office'], message: 'invalid' });
  });
export type CampaignLinkInput = z.output<typeof campaignLinkInputSchema>;

export const campaignLinkQuerySchema = z
  .object({ archived: z.enum(['true', 'false']).optional() })
  .strict();

/** The path and query of a link on the agency's own site (the page adds its address). */
export function linkPath(link: {
  kind: LinkKind;
  slug: string;
  office: number | null;
  locale: string;
}): string {
  const tags = LINK_TAGS[link.kind];
  const query = new URLSearchParams({
    utm_source: tags.source,
    utm_medium: tags.medium,
    utm_campaign: link.slug,
  });
  // The page reads ?office as 1-based (?office=1 is the first office).
  if (link.office !== null) query.set('office', String(link.office + 1));
  return `/${link.locale}/talk-to-us?${query.toString()}`;
}

export interface CampaignLink {
  id: string;
  kind: LinkKind;
  name: string;
  slug: string;
  office: number | null;
  locale: 'bn' | 'en';
  /** For example /bn/talk-to-us?utm_source=qr&utm_medium=event&utm_campaign=wedding-fair-dec. */
  path: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  archivedAt: string | null;
  /** Enquiries that came through this link (by its campaign name), and how many of them proved their number. */
  leads: number;
  verified: number;
}
