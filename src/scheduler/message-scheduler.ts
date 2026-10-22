import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

/** How often the API process sends what was held back, and reminds about meetings coming up. */
export const MESSAGE_ROUND_EVERY_MS = 5 * 60 * 1000;

/**
 * Two small jobs on one timer. The first adds the meeting reminder (the day before) to the inbox of the people a
 * meeting is about. The second sends the texts that could not go when their inbox line was added: held back by the
 * quiet hours, or missed in a restart. Running in more than one process is safe: both claim what they handle in a
 * single statement. A failed round is logged and tried again at the next tick.
 */
export function startMessageRounds(
  meetings: { remindUpcoming(agencyId: string, correlationId: string): Promise<number> },
  outside: { sweep(agencyId: string): Promise<number> },
  agencies: readonly string[],
  logger: Logger,
  everyMs: number = MESSAGE_ROUND_EVERY_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const agencyId of agencies) {
        try {
          const reminded = await meetings.remindUpcoming(agencyId, `meetings-${randomUUID()}`);
          if (reminded > 0) logger.info({ agencyId, reminded }, 'Meeting reminders added');
          const sent = await outside.sweep(agencyId);
          if (sent > 0) logger.info({ agencyId, sent }, 'Held texts sent');
        } catch {
          logger.error({ agencyId, code: 'MESSAGE_ROUND_FAILED' }, 'Message round failed');
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
