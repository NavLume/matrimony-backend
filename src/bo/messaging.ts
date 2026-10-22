import { z } from 'zod';

/**
 * Messages outside the app (22 October 2026): a short SMS telling a member that something is
 * waiting for them in the app. See migration 056.
 *
 *   - Only a member who agreed, on a phone number the account has verified, and only for the kinds below.
 *   - The text names only the kind of thing, never a name or a detail (a phone's lock screen is public).
 *   - Not at night: texts held between 9 pm and 8 am Bangladesh time go out in the morning.
 *   - A daily limit per agency and a limit per member (both settings of the admin), because every text costs money.
 *   - SMS only for now (owner decision, 22 October 2026). WhatsApp was built and removed; it can be added back behind
 *     its own sender if it is ever wanted.
 *   - Nothing goes out until a provider is configured; until then it is built and tested against a stub that
 *     prints the text in the backend's terminal.
 */
const fail = (key: string) => ({ error: key });

export const CHANNELS = ['none', 'sms'] as const;
export type MessageChannel = (typeof CHANNELS)[number];

export const messagePreferenceSchema = z
  .object({ channel: z.enum(CHANNELS, fail('invalidOption')) })
  .strict();

/**
 * The inbox kinds worth a text: the few that keep a proposal moving, because every text costs money (cut to four by
 * the owner on 22 October 2026). Everything else stays in the app inbox: an approved or declined or closed request,
 * new matches released, a profile decision, chat, payments and so on.
 */
export const MESSAGED_TEMPLATES = [
  /** A request is waiting for the member's answer. */
  'interest.received',
  /** A request they sent was accepted. */
  'interest.accepted',
  /** A meeting was set or changed. */
  'meeting.update',
  /** A meeting is coming up. */
  'meeting.reminder',
] as const;

/** Local night in Bangladesh: no text between these hours (from, until). */
export const QUIET_FROM_HOUR = 21;
export const QUIET_UNTIL_HOUR = 8;
export const MESSAGING_ZONE = 'Asia/Dhaka';

/** The default limit of texts an agency sends in a day. Zero turns outside messages off. */
export const DEFAULT_DAILY_LIMIT = 300;
export const MAX_DAILY_LIMIT = 5000;

/** The default most texts one member gets in a day; the rest stay in the app inbox. */
export const DEFAULT_PER_MEMBER_DAILY = 3;
export const MAX_PER_MEMBER_DAILY = 20;

export function inQuietHours(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: MESSAGING_ZONE })
      .format(now)
      .replace(/\D/g, ''),
  );
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

const MANY: Record<'bn' | 'en', (count: number) => string> = {
  bn: (count) => `আপনার ${count}টি নতুন নোটিশ আছে।`,
  en: (count) => `You have ${count} new notices.`,
};
const SOME: Record<'bn' | 'en', string> = {
  bn: 'আপনার নতুন নোটিশ আছে।',
  en: 'You have new notices.',
};
const OPEN: Record<'bn' | 'en', (host: string) => string> = {
  bn: (host) => `${host} দেখুন।`,
  en: (host) => `Open ${host}.`,
};

/** The text sent: the agency, what kind of thing (or how many), and where to read it. No name, no detail. */
export function messageText(
  templates: readonly string[],
  locale: 'bn' | 'en',
  agencyName: string,
  host: string,
  /** What one kind of thing is called in a push or text (supplied by the caller, so this file depends on no other layer). */
  bodyOf: (templateKey: string, locale: 'bn' | 'en') => string,
): string {
  const what =
    templates.length === 1 ? bodyOf(templates[0]!, locale) : MANY[locale](templates.length);
  return `${agencyName}: ${what} ${OPEN[locale](host)}`;
}

/**
 * The last text a member gets in a day (their limit is reached with it) is a summary: it says there are new notices
 * and where to read them, without saying which. Whatever else arrives later that day is covered by it, though no
 * text can name it.
 */
export function summaryText(locale: 'bn' | 'en', agencyName: string, host: string): string {
  return `${agencyName}: ${SOME[locale]} ${OPEN[locale](host)}`;
}

export interface MessagePreference {
  channel: MessageChannel;
  /** The agency sends texts at all (its admin turned them on). When false the member cannot choose a channel. */
  enabled: boolean;
  /** Which channels this agency can send on at all (a provider is configured). */
  available: { sms: boolean };
  /** The account's phone number partly hidden, or null when it has none. */
  phone: string | null;
  /** The number is verified, so texts may go to it. */
  phoneVerified: boolean;
}

export interface MessageUsage {
  /** The agency's switch. */
  enabled: boolean;
  today: number;
  thisMonth: number;
  failedToday: number;
  /** Today's limit; 0 means outside messages are off. */
  dailyLimit: number;
}
