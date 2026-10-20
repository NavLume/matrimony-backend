import { z } from 'zod';

/**
 * Ready for matching (decided with the owner on 20 October 2026). Staff may find and release candidates for
 * a client only when both steps are done, in either order: the agreed registration amount is recorded, and
 * the identity document is verified. An admin can let a client through with a reason.
 */
export interface MatchingReadiness {
  /** True when both steps are done, or an admin let the client through. */
  ready: boolean;
  agreementRecorded: boolean;
  verified: boolean;
  /** Set when an admin let the client through; the reason is shown to staff. */
  override: { at: string; reason: string; by: string | null } | null;
}

export const readinessOverrideSchema = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict();
export type ReadinessOverrideInput = z.infer<typeof readinessOverrideSchema>;
