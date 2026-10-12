import type { Logger } from 'pino';

/** How often the API process looks at the clock. The daily run itself is claimed in the database. */
export const NIGHTLY_CHECK_EVERY_MS = 30 * 60 * 1000;
/** The Bangladesh hour from which the nightly refresh may run (2 am). */
export const NIGHTLY_FROM_HOUR = 2;

/** The hour of day in Bangladesh (UTC+6, no daylight saving). */
export const bangladeshHour = (now: Date) => (now.getUTCHours() + 6) % 24;

/**
 * Refreshes every published client's list of proposals once a night, so an agent who forgot to press
 * "Find candidates" still finds new members there. It wakes every half hour and does something only
 * from 2 am Bangladesh time; the database decides which process runs today's refresh, so several
 * processes, or a restart, never repeat it. A failed run is logged and tried again at the next tick.
 */
export function startNightlyRefresh(
  candidates: { refreshNightly(agencyId: string): Promise<number | null> },
  agencies: readonly string[],
  logger: Logger,
  everyMs: number = NIGHTLY_CHECK_EVERY_MS,
  clock: () => Date = () => new Date(),
): () => void {
  let running = false;
  const tick = async () => {
    if (running || bangladeshHour(clock()) < NIGHTLY_FROM_HOUR) return;
    running = true;
    try {
      for (const agencyId of agencies) {
        try {
          const refreshed = await candidates.refreshNightly(agencyId);
          if (refreshed !== null) {
            logger.info({ agencyId, refreshed }, 'Nightly candidate refresh done');
          }
        } catch {
          logger.error({ agencyId, code: 'NIGHTLY_REFRESH_FAILED' }, 'Nightly refresh failed');
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
