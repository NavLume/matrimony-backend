import { z } from 'zod';

/**
 * A person's right to see and to remove their data (21 October 2026).
 *
 *   - The consent log: every agreement recorded for the person, with the version of the text and the date.
 *   - The data export: a copy of what the agency holds about the person, as one file. It holds their own
 *     details and records, never another person's (a proposal names the other side by member code only), and
 *     never the stored files (photos, CV, identity document: the person has those) and never staff's private
 *     notes about them (decided 21 October 2026: not copied, not even counted).
 *   - Erasure: see migration 052. A member asks for it themselves (POST /me/delete-account); for a client with
 *     no login an administrator does it, after typing the client's member code to confirm.
 */
const fail = (key: string) => ({ error: key });

export interface ConsentEntry {
  purpose: 'terms' | 'privacy' | 'profile_representation';
  documentVersion: string;
  action: 'accepted' | 'withdrawn';
  createdAt: string;
}

/** What an export holds. Sections are plain JSON so the person (or their lawyer) can read it without our software. */
export interface DataExport {
  generatedAt: string;
  /** Who this copy is for, and why it may not be complete. */
  subject: { memberCode: string; name: string; kind: 'member' | 'client_without_login' };
  notes: string[];
  account: Record<string, unknown> | null;
  profile: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
  partnerPreferences: Record<string, unknown> | null;
  photos: Record<string, unknown>[];
  cv: Record<string, unknown>[];
  verification: Record<string, unknown>[];
  guardians: Record<string, unknown>[];
  proposals: Record<string, unknown>[];
  meetings: Record<string, unknown>[];
  agreedAmounts: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  serviceTerms: Record<string, unknown>[];
  concerns: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  consents: ConsentEntry[];
}

/** Where the erasure of a client with no login stands. */
export interface ErasureState {
  status: 'none' | 'scheduled' | 'erased';
  /** When a scheduled erasure will happen. */
  erasesOn: string | null;
  /** Why, and who asked: kept after the erasure as the agency's record. */
  reason: string | null;
  requestedBy: string | null;
  erasedAt: string | null;
}

/**
 * An administrator asking for the erasure of a client who has no login: the client's member code is typed to
 * confirm, and a reason is required (kept with the request). The profile is hidden now and erased after 7 days
 * unless an administrator cancels.
 */
export const eraseClientSchema = z
  .object({
    memberCode: z.string(fail('required')).trim().min(3, fail('tooShort')).max(20, fail('tooLong')),
    reason: z.string(fail('required')).trim().min(5, fail('tooShort')).max(300, fail('tooLong')),
  })
  .strict();
export type EraseClientInput = z.output<typeof eraseClientSchema>;
