import type { Logger } from 'pino';

/** How often the API process looks for conversations to end and messages to erase. */
export const CHAT_MAINTENANCE_EVERY_MS = 60 * 60 * 1000;

/**
 * Ends conversations with a profile that is no longer published, and erases the messages of conversations
 * that ended more than 90 days ago. Running in more than one process is safe: both steps are single
 * statements that do nothing the second time. A failed round is logged and tried again at the next tick.
 */
export function startChatMaintenance(
  chats: { maintain(agencyId: string): Promise<{ ended: number; erased: number }> },
  agencies: readonly string[],
  logger: Logger,
  everyMs: number = CHAT_MAINTENANCE_EVERY_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const agencyId of agencies) {
        try {
          const { ended, erased } = await chats.maintain(agencyId);
          if (ended > 0 || erased > 0)
            logger.info({ agencyId, ended, erased }, 'Chat housekeeping done');
        } catch {
          logger.error({ agencyId, code: 'CHAT_MAINTENANCE_FAILED' }, 'Chat housekeeping failed');
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
