import { z } from 'zod';

/**
 * Identity verification (17 October 2026). A client, or the agent of an assisted client, sends one
 * identity document. Staff who look after the client compare it with the profile and approve or
 * reject it. An approved profile carries a "Verified" mark other members can see.
 *
 * - The document is private: only staff who look after the client can open it, and it is deleted
 *   from storage as soon as the request is decided. The platform keeps the fact, not the document.
 * - One request waits at a time. A rejected one can be sent again with a better file.
 * - Nobody decides their own submission, except an admin (the rule used for reviews).
 * - An admin can take the mark away again (the event log records who did it).
 */
const fail = (key: string) => ({ error: key });

export const DOCUMENT_TYPES = ['nid', 'passport', 'birth_certificate', 'driving_license'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const documentTypeSchema = z.enum(DOCUMENT_TYPES, fail('invalidOption'));

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_TYPES_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentMime = (typeof DOCUMENT_TYPES_MIME)[number];
export const DOCUMENT_EXTENSION: Record<DocumentMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const note = (min: number) =>
  z.string(fail('required')).trim().min(min, fail('tooShort')).max(300, fail('tooLong'));

/** Approving needs no words; rejecting needs a reason the person can act on. */
export const approveInputSchema = z.object({}).strict();
export const rejectInputSchema = z.object({ note: note(3) }).strict();

export type VerificationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface VerificationRequest {
  id: string;
  docType: DocumentType;
  status: VerificationStatus;
  submittedAt: string;
  decidedAt: string | null;
  /** The reason given when it was rejected. */
  note: string | null;
  /** The document can still be opened (only while the request waits). */
  hasFile: boolean;
}

/** Where a profile stands: whether it carries the mark, and the latest request. */
export interface VerificationState {
  verified: { at: string } | null;
  request: VerificationRequest | null;
}

/** One request waiting for a decision, as the staff list shows it. */
export interface VerificationWaiting {
  id: string;
  profile: { id: string; memberCode: string; fullName: string };
  docType: DocumentType;
  submittedAt: string;
  submittedBy: string;
}
