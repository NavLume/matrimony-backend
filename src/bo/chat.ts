import { z } from 'zod';

/**
 * Chat between two clients after an accepted proposal (decided with the owner on 17 October 2026).
 *
 * - One asks to chat and the other accepts. Text only, up to 1000 characters a message.
 * - Phone numbers, emails and links are hidden in the text before it is stored.
 * - Private by default: staff read a conversation only after a report, or when one of the two people
 *   invited their own agent (a chaperone). Each reading is logged and both people see who is in it.
 * - It ends when either profile stops being published, or when a person ends it, blocks the other, or
 *   staff end it. Messages are erased 90 days after it ended.
 * - A client who has no login cannot chat; giving them a login makes them eligible.
 */
const fail = (key: string) => ({ error: key });

export const MAX_MESSAGE_LENGTH = 1000;
/** How long messages are kept after a conversation ended. */
export const CHAT_RETENTION_DAYS = 90;
export const CHAT_PAGE_SIZE = 30;

export const messageInputSchema = z
  .object({
    body: z
      .string(fail('required'))
      .trim()
      .min(1, fail('required'))
      .max(MAX_MESSAGE_LENGTH, fail('tooLong')),
  })
  .strict();

export const respondInputSchema = z.object({ accept: z.boolean(fail('invalid')) }).strict();

export const reportInputSchema = z
  .object({
    reason: z.string(fail('required')).trim().min(3, fail('tooShort')).max(500, fail('tooLong')),
  })
  .strict();

export const resolveInputSchema = z
  .object({ note: z.string(fail('invalid')).trim().max(500, fail('tooLong')).optional() })
  .strict();

export const messagePageQuerySchema = z
  .object({ after: z.string().max(300, fail('tooLong')).optional() })
  .strict();

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
/** Bengali digits as Latin ones, one for one, so positions in the text do not move. */
const latinDigits = (text: string) =>
  text.replace(/[০-৯]/g, (digit) => String(BENGALI_DIGITS.indexOf(digit)));

const HIDDEN = '[hidden]';
const EMAIL = /[A-Z0-9._%+-]+\s?@\s?[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LINK = /\b(?:https?:\/\/|www\.|wa\.me\/|t\.me\/|bit\.ly\/)\S+/gi;
/** Eight or more digits with only spaces, dots, dashes or brackets between them (or a leading +). */
const NUMBER = /\+?\d(?:[\s().-]*\d){7,}/g;

/**
 * Hides phone numbers, email addresses and links, so a conversation does not move off the platform on
 * the first message. Returns the text to store and whether anything was hidden.
 */
export function maskContacts(text: string): { body: string; masked: boolean } {
  let body = text;
  let masked = false;
  const replace = (pattern: RegExp, source: (value: string) => string = (v) => v) => {
    // Matches are found in a copy (Bengali digits as Latin) and cut from the original at the same place.
    const found = [...source(body).matchAll(pattern)];
    for (const match of found.reverse()) {
      const start = match.index ?? 0;
      body = body.slice(0, start) + HIDDEN + body.slice(start + match[0].length);
      masked = true;
    }
  };
  replace(EMAIL);
  replace(LINK);
  replace(NUMBER, latinDigits);
  return { body, masked };
}

export type ChatStatus = 'requested' | 'active' | 'ended';
export type ChatEndReason =
  | 'declined'
  | 'ended_by_member'
  | 'blocked'
  | 'profile_unavailable'
  | 'ended_by_staff'
  | 'account_deleted';

/** The other person in a conversation, as the reader may see them. */
export interface ChatPerson {
  profileId: string;
  memberCode: string;
  /** Null when the reader may not see names. */
  fullName: string | null;
}

export interface ChatChaperone {
  accountId: string;
  name: string;
  invitedByMe: boolean;
}

export interface ChatSummary {
  id: string;
  status: ChatStatus;
  endReason: ChatEndReason | null;
  /** Who asked: me or them. */
  requestedBy: 'me' | 'them';
  other: ChatPerson;
  requestedAt: string;
  acceptedAt: string | null;
  endedAt: string | null;
  lastMessageAt: string | null;
  /** Messages from the other person not read yet. */
  unread: number;
  /** The latest message, already with contacts hidden. */
  preview: string | null;
  /** Whether messages may be sent now (the chat is active and both profiles are published). */
  canSend: boolean;
  chaperones: ChatChaperone[];
}

export interface ChatMessage {
  id: string;
  mine: boolean;
  body: string;
  masked: boolean;
  createdAt: string;
  read: boolean;
}

export interface ChatMessagePage {
  chat: ChatSummary;
  items: ChatMessage[];
  next: string | null;
}

/** What staff see of a client's conversations before any report: that they exist, never the text. */
export interface StaffChatRow {
  id: string;
  status: ChatStatus;
  endReason: ChatEndReason | null;
  other: { profileId: string; memberCode: string; fullName: string };
  requestedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  openReport: { id: string; reason: string; createdAt: string; byClient: boolean } | null;
  /** This staff member was invited into it, or it has an open report they may open. */
  canRead: boolean;
  invited: boolean;
}

export interface StaffMessagePage {
  chat: { id: string; status: ChatStatus; endReason: ChatEndReason | null };
  /** The two people, so the staff member can tell who said what. */
  people: { profileId: string; memberCode: string; fullName: string }[];
  items: { id: string; sender: string; body: string; createdAt: string }[];
  next: string | null;
}
