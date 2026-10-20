import type { FastifyInstance } from 'fastify';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

/** What the stream needs: who to hear about, and the unread count to send. */
export interface NotificationLive {
  subscribe(agencyId: string, accountId: string, listener: () => void): (() => void) | null;
  unread(actor: ProfileActor): Promise<number>;
}

const anyRole = {
  roles: ['member' as const, 'agent' as const, 'admin' as const, 'guardian' as const],
};

/** A stream ends after this long and the page opens a new one, so it never outlives its sign-in. */
export const STREAM_MAX_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 20_000;

/**
 * Live notifications: a server-sent event stream for the signed-in account.
 *
 * - It carries only the unread count (`event: unread`). The page then asks for the list in the usual
 *   way, with its own sign-in, so no inbox text is ever sent here.
 * - One event is sent at once (the count now), and another each time an inbox line is added for
 *   the account, or the connection to the database came back after a gap.
 * - A comment goes out every 20 seconds so proxies keep the connection open.
 * - An account may keep five streams open. A stream ends after ten minutes, which is as long as an
 *   access token lives, and the page reconnects with a fresh one.
 */
export function registerNotificationStream(app: FastifyInstance, live: NotificationLive) {
  app.get(
    '/api/v1/me/notifications/stream',
    { config: { ...anyRole, rateLimit: { max: 30, timeWindow: 60000 } } },
    async (req, reply) => {
      const actor: ProfileActor = {
        agencyId: req.principal!.agencyId,
        accountId: req.principal!.id,
        role: req.principal!.role,
      };

      let closed = false;
      let busy = false;
      let again = false;
      const raw = reply.raw;
      const write = (chunk: string) => {
        if (!closed) raw.write(chunk);
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Several lines added at once, or one while the count is being read, make one more read.
      const refresh = async () => {
        if (closed) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          do {
            again = false;
            send('unread', { unread: await live.unread(actor) });
          } while (again && !closed);
        } catch {
          // The account may have been turned off, or the database is down: end, and let the page decide.
          finish();
        } finally {
          busy = false;
        }
      };

      const stop = live.subscribe(actor.agencyId, actor.accountId, () => void refresh());
      if (!stop) throw new AppError(429, 'TOO_MANY_STREAMS');

      const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
      const limit = setTimeout(() => {
        send('end', {});
        finish();
      }, STREAM_MAX_MS);
      function finish() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(limit);
        stop?.();
        raw.end();
      }

      reply.hijack();
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // Tells a proxy in front not to hold the stream back.
        'x-accel-buffering': 'no',
      });
      write('retry: 5000\n\n');
      req.raw.on('close', finish);
      await refresh();
    },
  );
}
