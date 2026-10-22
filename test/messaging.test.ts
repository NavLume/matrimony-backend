import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { pushBody } from '../src/push/messages.js';
import { MESSAGED_TEMPLATES, inQuietHours, messageText, summaryText } from '../src/bo/messaging.js';
import { maskPhone } from '../src/bo/phone.js';
import type { MessagingUnit } from '../src/db/service/messaging-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { OutsideMessageProcess } from '../src/process/outside-message-process.js';
import { MessagingService } from '../src/service/messaging-service.js';

const agency = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222221';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

// Wednesday 22 October 2026, 11:00 in Dhaka (05:00 UTC) and 23:00 in Dhaka (17:00 UTC).
const DAY = new Date('2026-10-21T05:00:00.000Z');
const NIGHT = new Date('2026-10-21T17:00:00.000Z');

function fixture(
  options: {
    channel?: 'none' | 'sms';
    phone?: string | null;
    verified?: boolean;
    sentToday?: number;
    limit?: number;
    enabled?: boolean;
    perMember?: number;
    memberSentToday?: number;
    templates?: string[];
    now?: Date;
    failSend?: boolean;
    waiting?: string[];
  } = {},
) {
  const sent: { channel: string; to: string; text: string }[] = [];
  const logged: { channel: string; kinds: readonly string[]; status: string }[] = [];
  const claimed: string[] = [];
  const handled: string[] = [];
  const events: string[] = [];
  let channel = options.channel ?? 'sms';
  const unit = {
    preference: async () => channel,
    setPreference: async (_a: string, _b: string, value: typeof channel) => void (channel = value),
    contact: async () => ({
      role: 'member',
      phone: options.phone === undefined ? '+8801712345678' : options.phone,
      verified: options.verified ?? true,
      locale: 'en' as const,
      active: true,
    }),
    messagingSettings: async () => ({
      enabled: options.enabled ?? true,
      dailyLimit: options.limit ?? 300,
      perMemberDaily: options.perMember ?? 3,
    }),
    sentToday: async () => options.memberSentToday ?? 0,
    usage: async () => ({ today: options.sentToday ?? 0, thisMonth: 0, failedToday: 0 }),
    claim: async (_a: string, account: string) => {
      claimed.push(account);
      return options.templates ?? ['interest.received'];
    },
    markAllHandled: async (_a: string, account: string) => void handled.push(account),
    waiting: async () => options.waiting ?? [],
    log: async (_a: string, _b: string, ch: string, kinds: readonly string[], status: string) =>
      void logged.push({ channel: ch, kinds, status }),
    appendEvent: async (event: { type: string }) => void events.push(event.type),
  } as unknown as MessagingUnit;
  const db = {
    inTransaction: async <T>(_a: string, work: (u: MessagingUnit) => Promise<T>) => work(unit),
  };
  const sender = (name: string) => ({
    send: async (message: { to: string; text: string }) => {
      if (options.failSend) throw new Error('gateway down');
      sent.push({ channel: name, ...message });
    },
  });
  const process = new OutsideMessageProcess(
    db,
    { sms: sender('sms') },
    async () => ({ name: 'Marriage Solution BD', hostname: 'msbd.example.test' }),
    pino({ level: 'silent' }),
    () => options.now ?? DAY,
  );
  const service = new MessagingService(db, () => process.available());
  return { process, service, db, sent, logged, claimed, handled, events, channel: () => channel };
}

await test('the text names only the kind of thing, and where to read it: no name, no detail', () => {
  const one = messageText(
    ['interest.received'],
    'en',
    'Marriage Solution BD',
    'msbd.example.test',
    pushBody,
  );
  assert.equal(
    one,
    'Marriage Solution BD: You have a new connection request. Open msbd.example.test.',
  );
  assert.equal(
    messageText(['interest.received', 'meeting.update'], 'en', 'MSBD', 'x.test', pushBody),
    'MSBD: You have 2 new notices. Open x.test.',
  );
  assert.ok(
    messageText(['interest.received'], 'bn', 'MSBD', 'x.test', pushBody).startsWith('MSBD: '),
  );
});

await test('only the four kinds that keep a proposal moving are texted; the rest stay in the inbox', () => {
  assert.deepEqual([...MESSAGED_TEMPLATES].sort(), [
    'interest.accepted',
    'interest.received',
    'meeting.reminder',
    'meeting.update',
  ]);
  for (const left of [
    'interest.contact_shared',
    'interest.forwarded',
    'interest.declined',
    'interest.matched',
    'candidates.released',
    'profile.review_decided',
    'chat.message',
  ])
    assert.equal((MESSAGED_TEMPLATES as readonly string[]).includes(left), false, left);
});

await test('each kind says what happened, in the right direction: an approved request is not a new one, a closed one is not an acceptance', () => {
  const say = (kind: string) => messageText([kind], 'en', 'MSBD', 'x.test', pushBody);
  assert.match(say('interest.received'), /new connection request/);
  assert.match(say('interest.forwarded'), /approved/);
  assert.doesNotMatch(say('interest.forwarded'), /new connection request/);
  assert.match(say('interest.accepted'), /accepted/);
  assert.match(say('interest.matched'), /no longer open/);
  assert.doesNotMatch(say('interest.matched'), /accepted/);
});

await test('nothing is sent between 9 pm and 8 am in Bangladesh', () => {
  assert.equal(inQuietHours(DAY), false);
  assert.equal(inQuietHours(NIGHT), true);
  assert.equal(inQuietHours(new Date('2026-10-21T01:30:00.000Z')), true); // 07:30 in Dhaka
  assert.equal(inQuietHours(new Date('2026-10-21T02:00:00.000Z')), false); // 08:00 in Dhaka
});

await test('a member who agreed gets one short text on their channel, and it is counted', async () => {
  const f = fixture({ channel: 'sms' });
  assert.equal(await f.process.dispatch(agency, MEMBER), 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]?.channel, 'sms');
  assert.equal(f.sent[0]?.to, '+8801712345678');
  assert.deepEqual(f.logged, [{ channel: 'sms', kinds: ['interest.received'], status: 'sent' }]);
});

await test('nothing goes without an agreement, a verified number, an active limit or daytime', async () => {
  for (const options of [
    { channel: 'none' as const },
    { phone: null },
    { verified: false },
    { limit: 0 },
    { enabled: false },
    { sentToday: 300 },
    { memberSentToday: 3 },
    { templates: [] },
  ]) {
    const f = fixture(options);
    assert.equal(await f.process.dispatch(agency, MEMBER), 0, JSON.stringify(options));
    assert.deepEqual(f.sent, [], JSON.stringify(options));
  }
  const night = fixture({ now: NIGHT });
  assert.equal(await night.process.dispatch(agency, MEMBER), 0);
  // The lines are left for the morning: nothing was claimed.
  assert.deepEqual(night.claimed, []);
});

await test('a failed text is counted as failed, never thrown, and never retried in a loop', async () => {
  const f = fixture({ failSend: true });
  assert.equal(await f.process.dispatch(agency, MEMBER), 0);
  assert.deepEqual(f.logged, [{ channel: 'sms', kinds: ['interest.received'], status: 'failed' }]);
});

await test('the sweep sends what was held back, for each person waiting, but not at night', async () => {
  const f = fixture({ waiting: [MEMBER, ADMIN] });
  assert.equal(await f.process.sweep(agency), 2);
  const night = fixture({ waiting: [MEMBER], now: NIGHT });
  assert.equal(await night.process.sweep(agency), 0);
});

await test('turning a channel on needs a sender, a verified number, and sends nothing that was waiting', async () => {
  const actor = { agencyId: agency, accountId: MEMBER, role: 'member' as const };
  const noNumber = fixture({ channel: 'none', phone: null });
  await assert.rejects(noNumber.service.set(actor, 'sms', 'c'), code(409, 'PHONE_REQUIRED'));
  const unverified = fixture({ channel: 'none', verified: false });
  await assert.rejects(unverified.service.set(actor, 'sms', 'c'), code(409, 'PHONE_REQUIRED'));

  const f = fixture({ channel: 'none' });
  const chosen = await f.service.set(actor, 'sms', 'c');
  assert.equal(chosen.channel, 'sms');
  assert.equal(chosen.phone, maskPhone('+8801712345678'));
  assert.deepEqual(f.handled, [MEMBER]);
  assert.deepEqual(f.events, ['account.messaging_changed']);

  const off = await f.service.set(actor, 'none', 'c');
  assert.equal(off.channel, 'none');
  assert.deepEqual(f.handled, [MEMBER], 'turning it off marks nothing');
});

await test('while the agency has texts switched off nothing is sent, and nobody can agree to them', async () => {
  const off = fixture({ enabled: false, channel: 'sms', waiting: [MEMBER] });
  assert.equal(await off.process.dispatch(agency, MEMBER), 0);
  assert.equal(await off.process.sweep(agency), 0);
  assert.deepEqual(off.sent, []);
  const actor = { agencyId: agency, accountId: MEMBER, role: 'member' as const };
  const choosing = fixture({ enabled: false, channel: 'none' });
  await assert.rejects(choosing.service.set(actor, 'sms', 'c'), code(409, 'CHANNEL_NOT_AVAILABLE'));
  const seen = await choosing.service.get(actor);
  assert.equal(seen.enabled, false);
  // Turning it off for oneself is always allowed.
  assert.equal((await choosing.service.set(actor, 'none', 'c')).channel, 'none');
  // The choice a member made is kept while it is off, and works again once it is switched on.
  const kept = fixture({ enabled: false, channel: 'sms' });
  assert.equal((await kept.service.get(actor)).channel, 'sms');
});

await test('a member who has had their share of texts for the day gets no more; the rest stay in the inbox', async () => {
  const full = fixture({ perMember: 2, memberSentToday: 2 });
  assert.equal(await full.process.dispatch(agency, MEMBER), 0);
  assert.deepEqual(full.sent, []);
  // The lines were claimed, so they are not sent tomorrow as stale news.
  assert.deepEqual(full.claimed, [MEMBER]);
});

await test('the last text of the day is a summary that covers what comes after it; earlier ones say what happened', async () => {
  // Cap of 2: the first text names the kind of thing, the second says there are new notices.
  const first = fixture({ perMember: 2, memberSentToday: 0 });
  assert.equal(await first.process.dispatch(agency, MEMBER), 1);
  assert.match(first.sent[0]!.text, /new connection request/);
  const last = fixture({ perMember: 2, memberSentToday: 1 });
  assert.equal(await last.process.dispatch(agency, MEMBER), 1);
  assert.match(last.sent[0]!.text, /new notices/);
  assert.doesNotMatch(last.sent[0]!.text, /connection request/);
  // A cap of 1 means the one text is the summary.
  const only = fixture({ perMember: 1, memberSentToday: 0 });
  await only.process.dispatch(agency, MEMBER);
  assert.match(only.sent[0]!.text, /new notices/);
  assert.equal(summaryText('en', 'MSBD', 'x.test'), 'MSBD: You have new notices. Open x.test.');
});

await test('a channel with no sender cannot be chosen, and only a member chooses; an admin reads the usage', async () => {
  const bare = new MessagingService(fixture({ channel: 'none' }).db, () => ({
    sms: false,
  }));
  await assert.rejects(
    bare.set({ agencyId: agency, accountId: MEMBER, role: 'member' }, 'sms', 'c'),
    code(409, 'CHANNEL_NOT_AVAILABLE'),
  );
  const f = fixture();
  await assert.rejects(
    f.service.set({ agencyId: agency, accountId: ADMIN, role: 'admin' }, 'sms', 'c'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    f.service.usage({ agencyId: agency, accountId: MEMBER, role: 'member' }),
    code(403, 'ROLE_FORBIDDEN'),
  );
  const usage = await f.service.usage({ agencyId: agency, accountId: ADMIN, role: 'admin' });
  assert.equal(usage.dailyLimit, 300);
});
