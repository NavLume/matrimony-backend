import { z } from 'zod';
import type { MatchItem } from './matches.js';

/**
 * Connection requests and the inbox (slice 3.F, docs/features/discovery-loop.md).
 *
 * - A client asks to connect with someone in their window. Two people asking each other end as one
 *   accepted connection. A declined pair stays declined. A pending request can be withdrawn and asked
 *   again.
 * - The other person is told in their inbox. A client managed by an agent has no login, so the
 *   agent is told, and answers for them.
 * - Contact details stay private. After a connection is accepted, each person may share theirs with
 *   the other, each on their own say.
 */
const fail = (key: string) => ({ error: key });

/**
 * `in_review`: the request waits for the agent who looks after the person asked. Approving it makes
 * it `pending` (the person asked sees it); rejecting it ends it as `declined`.
 */
export const CONNECTION_STATUSES = [
  'in_review',
  'pending',
  'accepted',
  'declined',
  'withdrawn',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** received: waiting for my answer. sent: waiting for theirs. connected: accepted. */
export const CONNECTION_BOXES = ['received', 'sent', 'connected'] as const;
export type ConnectionBox = (typeof CONNECTION_BOXES)[number];

export const MAX_CONNECTION_PAGE = 50;
export const DEFAULT_CONNECTION_PAGE = 20;

const pageSize = z.coerce
  .number(fail('invalid'))
  .int(fail('invalid'))
  .min(1, fail('outOfRange'))
  .max(MAX_CONNECTION_PAGE, fail('outOfRange'))
  .default(DEFAULT_CONNECTION_PAGE);

export const connectionListQuerySchema = z
  .object({
    box: z.enum(CONNECTION_BOXES, fail('invalidOption')).default('received'),
    limit: pageSize,
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type ConnectionListQuery = z.output<typeof connectionListQuerySchema>;

export const NOTIFICATION_GROUPS = [
  'requests',
  'answers',
  'contact',
  'reviews',
  'updates',
  'chats',
] as const;
const day = z.string(fail('invalid')).regex(/^\d{4}-\d{2}-\d{2}$/, fail('invalid'));

/**
 * The inbox page, narrowed by any of: a group of lines, read or unread, a first and last day, a
 * search for a member code or name, and (staff) one client.
 */
export const notificationQuerySchema = z
  .object({
    limit: pageSize,
    after: z.string().max(300, fail('tooLong')).optional(),
    group: z.enum(NOTIFICATION_GROUPS, fail('invalidOption')).optional(),
    read: z.enum(['read', 'unread'], fail('invalidOption')).optional(),
    from: day.optional(),
    to: day.optional(),
    q: z.string().trim().min(1, fail('required')).max(60, fail('tooLong')).optional(),
    client: z.uuid(fail('invalid')).optional(),
  })
  .strict();
export type NotificationQuery = z.output<typeof notificationQuerySchema>;

/** What the inbox is narrowed by, ready for the query (null when not used). */
export interface NotificationFilter {
  kinds: NotificationKind[] | null;
  read: boolean | null;
  from: string | null;
  to: string | null;
  text: string | null;
  client: string | null;
}

/** The kinds of line in each group the inbox can be narrowed to. */
export const NOTIFICATION_GROUP_KINDS: Record<
  (typeof NOTIFICATION_GROUPS)[number],
  NotificationKind[]
> = {
  requests: [
    'connection_request',
    'connection_forwarded',
    'connection_review',
    'connection_review_reminder',
    'connection_unavailable',
    'connection_matched',
  ],
  answers: ['connection_accepted', 'connection_declined'],
  contact: ['contact_shared'],
  reviews: ['review_requested', 'review_decided'],
  updates: [
    'candidates_released',
    'client_assigned',
    'staff_joined',
    'meeting_update',
    'guardian_request',
    'guardian_advice',
  ],
  chats: ['chat_requested', 'chat_accepted', 'chat_message', 'chat_reported', 'chat_invited'],
};

/** The lines to mark as read. No `ids` means every unread line. */
export const markReadSchema = z
  .object({
    ids: z
      .array(z.uuid(fail('invalid')))
      .min(1, fail('invalid'))
      .max(100, fail('tooLong'))
      .optional(),
  })
  .strict();

/** A short note may travel with a request. It is kept short so it stays an introduction. */
export const MAX_NOTE_WORDS = 40;
export const MAX_NOTE_LENGTH = 300;

const noteSchema = z
  .string(fail('invalid'))
  .trim()
  .min(1, fail('required'))
  .max(MAX_NOTE_LENGTH, fail('tooLong'))
  .refine((text) => text.split(/\s+/).length <= MAX_NOTE_WORDS, fail('tooLong'));

export const sendRequestSchema = z
  .object({ candidateId: z.uuid(fail('invalid')), note: noteSchema.optional() })
  .strict();

export const reviewSchema = z
  .object({ decision: z.enum(['approve', 'reject'], fail('invalidOption')) })
  .strict();

export const reviewQueueQuerySchema = z
  .object({ limit: pageSize, after: z.string().max(300, fail('tooLong')).optional() })
  .strict();
export type ReviewQueueQuery = z.output<typeof reviewQueueQuerySchema>;
export const respondSchema = z
  .object({ response: z.enum(['accept', 'decline'], fail('invalidOption')) })
  .strict();

/** A profile as the connection code needs it. */
export interface ProfileLite {
  id: string;
  status: string;
  serviceMode: 'self_service' | 'assisted';
  ownerId: string | null;
  assignedAgentId: string | null;
}

/** The account that is told when something happens to this profile: its owner, or the agent who looks after it. */
export const recipientOf = (profile: ProfileLite): string | null =>
  profile.serviceMode === 'self_service' ? profile.ownerId : profile.assignedAgentId;

/** A connection as stored. */
export interface ConnectionRecord {
  id: string;
  fromProfileId: string;
  toProfileId: string;
  status: ConnectionStatus;
  fromShared: boolean;
  toShared: boolean;
}

/** What happened when a client asked to connect. `requested` also covers a request now waiting for review. */
export type SendOutcome = 'requested' | 'accepted' | 'unchanged';

export interface SendResult {
  outcome: SendOutcome;
  connectionId: string;
  status: ConnectionStatus;
}

/** One connection in a list, with the other person as the viewer may see them. */
export interface ConnectionRow {
  connectionId: string;
  status: ConnectionStatus;
  direction: 'sent' | 'received';
  createdAt: string;
  respondedAt: string | null;
  iShared: boolean;
  theyShared: boolean;
  /** The short note the asker added, when there is one and the viewer is the person asked. */
  note: string | null;
  position: string;
  /** What the client's guardian advised about this proposal, if they did. */
  guardianAdvice: { advice: 'supportive' | 'concerned'; note: string | null; at: string } | null;
  profile: MatchItem;
}

export interface ConnectionPage {
  items: ConnectionRow[];
  next: string | null;
}

export type NotificationKind =
  | 'connection_request'
  | 'connection_accepted'
  | 'connection_declined'
  /** The asker: the agent of the person asked approved the request; it now waits for their answer. */
  | 'connection_forwarded'
  /** The other side of an accepted connection shared their contact details. */
  | 'contact_shared'
  /** An admin: a person accepted their staff invitation. */
  | 'staff_joined'
  /** Staff: a request for a client of theirs waits for their review. */
  | 'connection_review'
  /** Staff: a request has waited for review for a while. */
  | 'connection_review_reminder'
  /** A request was withdrawn because the person asked matched with another participant. */
  | 'connection_matched'
  /** A request was withdrawn because the person asked is no longer available (paused or closed). */
  | 'connection_unavailable'
  /** Staff: something was sent for review (a profile, a change, a photo or a CV). */
  | 'review_requested'
  /** A request that was sent for review (profile, change, photo or CV) was approved or rejected. */
  | 'review_decided'
  /** A client who signs in: new profiles were released to them. */
  | 'candidates_released'
  /** An agent: a new client was given to them. */
  | 'client_assigned'
  /** The other side of an accepted proposal asked to chat. */
  | 'chat_requested'
  /** They agreed to chat. */
  | 'chat_accepted'
  /** A new message waits (the first one not read yet). */
  | 'chat_message'
  /** Staff: a client reported a conversation. */
  | 'chat_reported'
  /** Staff: a client invited them into a conversation. */
  | 'chat_invited'
  /** A meeting of an accepted proposal was set, moved or cancelled. */
  | 'meeting_update'
  /** The agency asked for a guardian and the client has to agree. */
  | 'guardian_request'
  /** The guardian gave advice on a proposal. */
  | 'guardian_advice';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  position: string;
  /** The recipient has read it. */
  read: boolean;
  /** The connection this is about. Null for lines that are not about a connection. */
  connectionId: string | null;
  /** For a review request or its decision: what was sent (profile, edit, photo or cv). */
  what: string | null;
  /** For a decision: whether it was approved or rejected. */
  decision: 'approved' | 'rejected' | null;
  /** For a staff account that joined: who, and as what. */
  staff: { name: string; role: string } | null;
  /** For a release: how many profiles. */
  count: number | null;
  /** For a chat line: the conversation. */
  chatId: string | null;
  /** The profile this is about for the recipient: their own, or the client they look after. */
  forProfileId: string | null;
  about: {
    profileId: string;
    memberCode: string;
    /** Null when the recipient may not see names. */
    fullName: string | null;
  } | null;
}

export interface NotificationPage {
  items: NotificationItem[];
  next: string | null;
}

/** A request waiting for review: who asked whom, and the note if there is one. */
export interface ReviewRequestRow {
  connectionId: string;
  createdAt: string;
  /** When it started waiting, which is what the reminders count from. */
  waitingSince: string;
  remindersSent: number;
  note: string | null;
  position: string;
  asker: ReviewParty;
  /** The client the request is for. */
  client: ReviewParty;
}

export interface ReviewParty {
  profileId: string;
  memberCode: string;
  fullName: string;
  age: number | null;
  professionCode: string | null;
  currentDistrictCode: string | null;
}

export interface ReviewQueuePage {
  items: ReviewRequestRow[];
  next: string | null;
  /** How many wait in all, for the badge. */
  total: number;
}

/** A connection on a client's page, for staff: who asked whom and where it stands. */
export interface StaffConnectionRow {
  connectionId: string;
  status: ConnectionStatus;
  /** From the client's side: they asked (`sent`) or the other person did (`received`). */
  direction: 'sent' | 'received';
  createdAt: string;
  respondedAt: string | null;
  /** The client has shared their contact details. */
  clientShared: boolean;
  /** The other person has shared theirs. */
  otherShared: boolean;
  /** What the client's guardian advised about this proposal, if they did. */
  guardianAdvice: { advice: 'supportive' | 'concerned'; note: string | null; at: string } | null;
  other: {
    profileId: string;
    memberCode: string;
    fullName: string;
    age: number | null;
    professionCode: string | null;
    currentDistrictCode: string | null;
    serviceMode: 'self_service' | 'assisted';
  };
}
