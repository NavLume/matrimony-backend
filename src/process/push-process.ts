import type { Logger } from 'pino';
import type { PushDbService } from '../db/service/push-db-service.js';
import { pushBody } from '../push/messages.js';
import type { PushSender } from '../push/push-sender.js';

export interface PushRegistration {
  platform: 'ios' | 'android';
  token: string;
  locale: 'bn' | 'en';
}

const MANY: Record<'bn' | 'en', (count: number) => string> = {
  bn: (count) => `আপনার ${count}টি নতুন নোটিশ আছে। দেখতে অ্যাপ খুলুন।`,
  en: (count) => `You have ${count} new notices. Open the app to read them.`,
};

/**
 * Push notifications for the mobile app. A phone registers its token after sign-in and removes it on
 * sign-out. When an inbox line is added, the lines not yet pushed are claimed and one short push goes
 * to each of the account's phones. The text names only the kind of event (see push/messages.ts).
 */
export class PushProcess {
  constructor(
    private readonly db: Pick<PushDbService, 'register' | 'unregister' | 'forget' | 'take'>,
    private readonly sender: PushSender,
    private readonly agencyName: (agencyId: string) => Promise<string>,
    private readonly logger: Logger,
  ) {}

  register(actor: { agencyId: string; accountId: string }, device: PushRegistration) {
    return this.db.register(actor.agencyId, actor.accountId, device);
  }

  unregister(actor: { agencyId: string; accountId: string }, token: string) {
    return this.db.unregister(actor.agencyId, actor.accountId, token);
  }

  /** Never throws: a failed push must not affect the change that caused it. */
  async dispatch(agencyId: string, accountId: string): Promise<number> {
    try {
      const { kinds, devices } = await this.db.take(agencyId, accountId);
      if (kinds.length === 0 || devices.length === 0) return 0;
      const title = await this.agencyName(agencyId);
      let sent = 0;
      for (const device of devices) {
        const body =
          kinds.length === 1
            ? pushBody(kinds[0]!, device.locale)
            : MANY[device.locale](kinds.length);
        const outcome = await this.sender.send(
          { platform: device.platform, token: device.token },
          { title, body },
        );
        if (outcome === 'invalid_token') await this.db.forget(agencyId, device.id);
        else sent += 1;
      }
      return sent;
    } catch {
      this.logger.error({ code: 'PUSH_DISPATCH_FAILED' }, 'Push delivery failed');
      return 0;
    }
  }
}
