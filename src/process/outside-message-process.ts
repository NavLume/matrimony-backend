import type { Logger } from 'pino';
import { pushBody } from '../push/messages.js';
import { inQuietHours, messageText, summaryText, type MessageChannel } from '../bo/messaging.js';
import type { MessagingDbService } from '../db/service/messaging-db-service.js';
import type { SmsSender } from '../sms/sender.js';

/** How many people one sweep looks at, so a backlog never makes one round long. */
const SWEEP_LIMIT = 100;

/**
 * Sends the short text (SMS) that tells a member something is waiting in the app (see
 * bo/messaging.ts). It runs when an inbox line is added, and again on a timer for what could not go at the time
 * (the quiet hours, a restart). It never throws: a failed text must not affect the change that caused it.
 *
 * A text goes only when the person agreed to a channel, the account has a verified number, it is not night in
 * Bangladesh, the agency has turned texts on, and it is under its daily limit and the member under theirs. What was sent is counted in outbound_messages, which holds
 * no text and no number.
 */
export class OutsideMessageProcess {
  constructor(
    private readonly db: Pick<MessagingDbService, 'inTransaction'>,
    private readonly senders: { sms?: SmsSender },
    private readonly agency: (agencyId: string) => Promise<{ name: string; hostname: string }>,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Which channels can be used at all: those with a configured sender. */
  available() {
    return { sms: this.senders.sms !== undefined };
  }

  /** Sends what is waiting for one account. Returns how many texts went (0 or 1). */
  async dispatch(agencyId: string, accountId: string): Promise<number> {
    try {
      if (inQuietHours(this.now())) return 0;
      const taken = await this.db.inTransaction(agencyId, async (unit) => {
        const channel = await unit.preference(agencyId, accountId);
        if (channel === 'none') return null;
        const contact = await unit.contact(agencyId, accountId);
        if (!contact || !contact.active || !contact.verified || !contact.phone) return null;
        const { enabled, dailyLimit, perMemberDaily } = await unit.messagingSettings(agencyId);
        if (!enabled || dailyLimit <= 0 || (await unit.usage(agencyId)).today >= dailyLimit)
          return null;
        const templates = await unit.claim(agencyId, accountId);
        if (templates.length === 0) return null;
        // A member who has had their share for the day gets no more: what was claimed stays in the app inbox.
        const sentToday = await unit.sentToday(agencyId, accountId);
        if (sentToday >= perMemberDaily) return null;
        // The last text of the day is a summary (it says there are new notices, not which), so it also covers
        // whatever arrives after it that day, which no further text can.
        const last = sentToday + 1 >= perMemberDaily;
        return { channel, phone: contact.phone, locale: contact.locale, templates, last };
      });
      if (!taken) return 0;

      const { name, hostname } = await this.agency(agencyId);
      const text = taken.last
        ? summaryText(taken.locale, name, hostname)
        : messageText(taken.templates, taken.locale, name, hostname, pushBody);
      let status: 'sent' | 'failed' = 'sent';
      try {
        await this.sender(taken.channel).send({ to: taken.phone, text });
      } catch {
        // Only the code is logged: the number and the text are never written down.
        status = 'failed';
        this.logger.error(
          { code: 'OUTSIDE_MESSAGE_FAILED', channel: taken.channel },
          'A text failed',
        );
      }
      await this.db.inTransaction(agencyId, (unit) =>
        unit.log(
          agencyId,
          accountId,
          taken.channel as Exclude<MessageChannel, 'none'>,
          taken.templates,
          status,
        ),
      );
      return status === 'sent' ? 1 : 0;
    } catch {
      this.logger.error({ code: 'OUTSIDE_DISPATCH_FAILED' }, 'Outside message delivery failed');
      return 0;
    }
  }

  /** Sends what was waiting for people who agreed: the end of the quiet hours, or a restart. */
  async sweep(agencyId: string): Promise<number> {
    if (inQuietHours(this.now())) return 0;
    const accounts = await this.db.inTransaction(agencyId, async (unit) =>
      // Nothing to look for while the agency has texts off.
      (await unit.messagingSettings(agencyId)).enabled ? unit.waiting(agencyId, SWEEP_LIMIT) : [],
    );
    let sent = 0;
    for (const accountId of accounts) sent += await this.dispatch(agencyId, accountId);
    return sent;
  }

  private sender(channel: MessageChannel): {
    send(message: { to: string; text: string }): Promise<void>;
  } {
    const sender = channel === 'sms' ? this.senders.sms : undefined;
    if (!sender) throw new Error('NO_SENDER');
    return sender;
  }
}
