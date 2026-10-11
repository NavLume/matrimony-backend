import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

/** How often the API process looks for requests that have waited too long for review. */
export const REVIEW_REMINDER_EVERY_MS = 15 * 60 * 1000;

/**
 * Reminds reviewers about requests waiting for review (after 2 days, then every 3). It runs inside
 * the API process on a timer. Running in more than one process is safe: the rows due are locked with
 * SKIP LOCKED and marked as reminded in the same transaction, so a request is reminded once per round.
 * A failed round is logged and tried again at the next tick.
 */
export function startReviewReminders(
  connections: { remindStale(agencyId: string, correlationId: string): Promise<number> },
  agencies: readonly string[],
  logger: Logger,
  everyMs: number = REVIEW_REMINDER_EVERY_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const agencyId of agencies) {
        try {
          const reminded = await connections.remindStale(agencyId, `reminders-${randomUUID()}`);
          if (reminded > 0) logger.info({ agencyId, reminded }, 'Review reminders sent');
        } catch {
          logger.error(
            { agencyId, code: 'REVIEW_REMINDER_FAILED' },
            'Review reminder round failed',
          );
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
