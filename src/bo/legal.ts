import { z } from 'zod';
import { PRIVACY_VERSION, TERMS_VERSION } from './registration.js';

/**
 * The agency's own terms of service and privacy policy (20 October 2026). The agency admin writes them,
 * in Bengali and English, from the dashboard. Every save is a new numbered version that is kept for good
 * (table `legal_documents`), and the latest one is shown to the public. A registration records the
 * version that was current when the person agreed. Only people who register afterwards agree to a new
 * version: existing members are not asked again (decided 20 October 2026).
 *
 * With no text of its own an agency shows the platform's draft, whose version is the old fixed one.
 */
const fail = (key: string) => ({ error: key });

export const LEGAL_KINDS = ['terms', 'privacy'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];
export const legalKindSchema = z.enum(LEGAL_KINDS);

export const MAX_LEGAL_CHARS = 40000;

const clean = (max: number) =>
  z
    .string(fail('invalid'))
    .max(max, fail('tooLong'))
    .transform((value) => value.replace(/\r\n/g, '\n').trim())
    .transform((value) => (value === '' ? undefined : value))
    .optional();

const localized = (max: number) =>
  z
    .object({ bn: clean(max), en: clean(max) })
    .strict()
    .optional()
    .transform((value) => (value && (value.bn || value.en) ? value : undefined));

/** What an admin sends. Both texts empty means "use the platform's draft again". */
export const legalInputSchema = z
  .object({ title: localized(200), body: localized(MAX_LEGAL_CHARS) })
  .strict();
export type LegalInput = z.output<typeof legalInputSchema>;

export type LocalizedText = { bn?: string; en?: string };

export interface LegalDocument {
  kind: LegalKind;
  /** 0 when the agency never wrote one. */
  version: number;
  title?: LocalizedText;
  body?: LocalizedText;
  createdAt?: string;
}

/** The two version strings a registration records. */
export interface LegalVersions {
  terms: string;
  privacy: string;
}
export type LegalVersionSource = (agencyId: string) => Promise<LegalVersions>;

/** Before an agency writes its own text, and in tests: the platform's fixed draft versions. */
export const platformLegalVersions: LegalVersionSource = async () => ({
  terms: TERMS_VERSION,
  privacy: PRIVACY_VERSION,
});

/** The version to record for a document: the platform draft's, or the agency's numbered one. */
export function versionOf(kind: LegalKind, document: Pick<LegalDocument, 'version' | 'body'>) {
  if (!document.body || (!document.body.bn && !document.body.en))
    return kind === 'terms' ? TERMS_VERSION : PRIVACY_VERSION;
  return `agency-v${document.version}`;
}
