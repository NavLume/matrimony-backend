import { z } from 'zod';

/**
 * A profile's CV: one PDF. These limits are development defaults to confirm with the client.
 *
 * - A member's upload waits for a reviewer; staff uploading for an assisted client publish at once.
 * - Replacing keeps the old CV published until the new one is approved.
 * - Other people see it only once a connection is accepted. It is never in a list or a search.
 */
export const MAX_CV_BYTES = 5 * 1024 * 1024;
export const CV_TYPE = 'application/pdf';
export const MAX_CV_NAME = 120;

export type CvStatus = 'pending' | 'published' | 'rejected' | 'removed';

/** A stored CV as the workflow needs it. The storage key is never sent to a client. */
export interface CvRecord {
  id: string;
  storageKey: string;
  fileName: string;
  byteSize: number;
  status: CvStatus;
  uploadedAt: string;
  uploadedByStaff: boolean;
  reviewerNotes: string | null;
}

/** What a person is told about a CV. */
export interface CvInfo {
  id: string;
  fileName: string;
  byteSize: number;
  uploadedAt: string;
  uploadedByStaff: boolean;
}

/** The owner's picture: the CV others can see, and the replacement waiting or turned down. */
export interface CvState {
  current: CvInfo | null;
  replacement: (CvInfo & { state: 'waiting' | 'rejected'; reviewerNotes: string | null }) | null;
}

export const reviewCvSchema = z
  .object({
    decision: z.enum(['approve', 'reject'], { error: 'invalidOption' }),
    notes: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * The name shown for a download: what the browser reported, with any path, control characters and
 * quotes taken out, kept short, and always ending in .pdf.
 */
export function safeFileName(raw: string | undefined): string {
  let name = '';
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    name = raw ?? '';
  }
  name = name
    .replace(/^.*[\\/]/, '')
    .replace(/[\u0000-\u001f\u007f"<>:*?|]/g, '')
    .trim();
  name = name
    .replace(/\.pdf$/i, '')
    .slice(0, MAX_CV_NAME - 4)
    .trim();
  return `${name || 'cv'}.pdf`;
}
