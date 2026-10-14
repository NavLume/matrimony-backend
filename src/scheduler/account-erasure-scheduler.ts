import type { Logger } from 'pino';

/** How often the API process looks for accounts whose waiting time is over. */
export const ACCOUNT_ERASURE_EVERY_MS = 60 * 60 * 1000;

/**
 * Erases the accounts that asked to be deleted, once their 14 days are over. Running in more than one
 * process is safe: each account is locked with SKIP LOCKED while it is erased. A failed round is
 * logged and tried again at the next tick.
 */
export function startAccountErasure(
  deletions: { eraseDue(agencyId: string): Promise<number> },
  agencies: readonly string[],
  logger: Logger,
  everyMs: number = ACCOUNT_ERASURE_EVERY_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const agencyId of agencies) {
        try {
          const erased = await deletions.eraseDue(agencyId);
          if (erased > 0) logger.info({ agencyId, erased }, 'Accounts erased');
        } catch {
          logger.error(
            { agencyId, code: 'ACCOUNT_ERASURE_FAILED' },
            'Account erasure round failed',
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
