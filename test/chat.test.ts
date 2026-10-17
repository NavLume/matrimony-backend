import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskContacts } from '../src/bo/chat.js';
import { ChatService } from '../src/service/chat-service.js';
import type { ChatUnit } from '../src/db/service/chat-db-service.js';
import type { ConversationRow } from '../src/db/raw/repository/chat-repository.js';
import { AppError } from '../src/exception/app-error.js';
import { agency } from './fixtures.js';

const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('phone numbers, emails and links are hidden, in Latin and Bengali digits', () => {
  assert.deepEqual(maskContacts('Hello, how are you?'), {
    body: 'Hello, how are you?',
    masked: false,
  });
  assert.equal(maskContacts('call 01712345678 now').body, 'call [hidden] now');
  assert.equal(maskContacts('call +880 1712-345 678 now').body, 'call [hidden] now');
  assert.equal(maskContacts('ফোন ০১৭১২৩৪৫৬৭৮ এ').body, 'ফোন [hidden] এ');
  assert.equal(
    maskContacts('mail me: a.b+c@example.co.uk please').body,
    'mail me: [hidden] please',
  );
  assert.equal(
    maskContacts('see https://wa.me/8801712345678 and www.example.com').body,
    'see [hidden] and [hidden]',
  );
  // Small numbers (an age, a year, a height) are not phone numbers.
  assert.equal(maskContacts('I am 28, born 1998, 5 feet 6').masked, false);
});

const A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const ACCOUNT_A = '33333333-3333-4333-8333-aaaaaaaaaaaa';
const ACCOUNT_B = '44444444-4444-4444-8444-bbbbbbbbbbbb';
const profile = (id: string, owner: string | null, status = 'active') => ({
  id,
  memberCode: id === A ? 'M1' : 'M2',
  fullName: id === A ? 'Rahim' : 'Nusrat',
  status,
  ownerAccountId: owner,
  assignedAgentId: null,
});

function fixture(options: { bStatus?: string; bOwner?: string | null; enabled?: boolean } = {}) {
  const store = new Map<string, ConversationRow>();
  const sent: string[] = [];
  const notices: string[] = [];
  const profiles = new Map([
    [A, profile(A, ACCOUNT_A)],
    [
      B,
      profile(
        B,
        options.bOwner === undefined ? ACCOUNT_B : options.bOwner,
        options.bStatus ?? 'active',
      ),
    ],
  ]);
  const unit = {
    chatEnabled: async () => options.enabled ?? true,
    ownProfile: async (_a: string, account: string) =>
      [...profiles.values()].find((p) => p.ownerAccountId === account) ?? null,
    profileById: async (_a: string, id: string) => profiles.get(id) ?? null,
    interest: async () => ({
      id: 'i1',
      status: 'accepted',
      senderProfileId: A,
      recipientProfileId: B,
    }),
    byInterest: async () => store.get('c1') ?? null,
    byId: async (_a: string, id: string) => store.get(id) ?? null,
    insertConversation: async (_a: string, i: { id: string; requestedBy: string }) => {
      store.set('c1', {
        id: 'c1',
        interestId: 'i1',
        profileA: A,
        profileB: B,
        requestedBy: i.requestedBy,
        status: 'requested',
        endReason: null,
        requestedAt: 'x',
        acceptedAt: null,
        endedAt: null,
        lastMessageAt: null,
      });
    },
    activate: async (_a: string, id: string) => {
      store.get(id)!.status = 'active';
    },
    end: async (_a: string, id: string, reason: ConversationRow['endReason']) => {
      Object.assign(store.get(id)!, { status: 'ended', endReason: reason });
    },
    reopen: async (_a: string, id: string, by: string) => {
      Object.assign(store.get(id)!, { status: 'requested', endReason: null, requestedBy: by });
    },
    listFor: async (_a: string, me: string) =>
      [...store.values()].map((c) => ({
        ...c,
        other: {
          ...profiles.get(c.profileA === me ? c.profileB : c.profileA)!,
          profileId: c.profileA === me ? c.profileB : c.profileA,
        },
        unread: 0,
        preview: null,
      })),
    chaperones: async () => [],
    visibleFields: async () => null,
    unreadFrom: async () => 0,
    insertMessage: async (_a: string, m: { body: string }) => {
      sent.push(m.body);
    },
    markRead: async () => {},
    notify: async (_a: string, account: string, template: string) => {
      notices.push(`${template}:${account}`);
    },
    isChaperone: async () => false,
    openReport: async () => null,
    appendEvent: async () => {},
  } as unknown as ChatUnit;
  const service = new ChatService({ inTransaction: async (_a, work) => work(unit) });
  return { service, sent, notices, store };
}
const rahim = { agencyId: agency, accountId: ACCOUNT_A, role: 'member' as const };
const nusrat = { agencyId: agency, accountId: ACCOUNT_B, role: 'member' as const };

await test('a chat starts only when both sides agree, and the other person is told', async () => {
  const f = fixture();
  const asked = await f.service.request(rahim, 'i1', 'c');
  assert.equal(asked.status, 'requested');
  assert.deepEqual(f.notices, [`chat.requested:${ACCOUNT_B}`]);
  await assert.rejects(f.service.send(rahim, 'c1', 'hello'), code(409, 'CHAT_NOT_ACTIVE'));
  await assert.rejects(f.service.respond(rahim, 'c1', true, 'c'), code(409, 'CHAT_NOT_PENDING'));
  const accepted = await f.service.respond(nusrat, 'c1', true, 'c');
  assert.equal(accepted.status, 'active');
  assert.equal(accepted.canSend, true);
  // Both asking is the same as one asking and the other accepting.
  const g = fixture();
  await g.service.request(rahim, 'i1', 'c');
  assert.equal((await g.service.request(nusrat, 'i1', 'c')).status, 'active');
});

await test('a message is stored with contacts hidden, and refused when the chat is not usable', async () => {
  const f = fixture();
  await f.service.request(rahim, 'i1', 'c');
  await f.service.respond(nusrat, 'c1', true, 'c');
  const message = await f.service.send(rahim, 'c1', 'my number is 01712345678');
  assert.equal(message.masked, true);
  assert.deepEqual(f.sent, ['my number is [hidden]']);
  f.store.get('c1')!.status = 'ended';
  await assert.rejects(f.service.send(rahim, 'c1', 'hello'), code(409, 'CHAT_NOT_ACTIVE'));
  const g = fixture({ bStatus: 'paused' });
  await assert.rejects(g.service.request(rahim, 'i1', 'c'), code(409, 'CHAT_NOT_AVAILABLE'));
});

await test('a client with no login, or an agency with chat off, cannot chat', async () => {
  await assert.rejects(
    fixture({ bOwner: null }).service.request(rahim, 'i1', 'c'),
    code(409, 'CHAT_NOT_AVAILABLE'),
  );
  await assert.rejects(
    fixture({ enabled: false }).service.request(rahim, 'i1', 'c'),
    code(409, 'CHAT_DISABLED'),
  );
});

await test('a blocked chat cannot be asked for again, a declined one can', async () => {
  const f = fixture();
  await f.service.request(rahim, 'i1', 'c');
  await f.service.respond(nusrat, 'c1', false, 'c');
  assert.equal(f.store.get('c1')!.endReason, 'declined');
  assert.equal((await f.service.request(rahim, 'i1', 'c')).status, 'requested');
  await f.service.respond(nusrat, 'c1', true, 'c');
  await f.service.end(nusrat, 'c1', true, 'c');
  await assert.rejects(f.service.request(rahim, 'i1', 'c'), code(409, 'CHAT_NOT_ALLOWED'));
});

await test('staff cannot read a conversation that was not reported and that they were not invited to', async () => {
  const f = fixture();
  await f.service.request(rahim, 'i1', 'c');
  const staff = {
    agencyId: agency,
    accountId: '55555555-5555-4555-8555-cccccccccccc',
    role: 'admin' as const,
  };
  await assert.rejects(
    f.service.staffMessages(staff, 'c1', undefined, 'c'),
    code(403, 'CHAT_NOT_SHARED'),
  );
  await assert.rejects(f.service.list(staff), code(403, 'ROLE_FORBIDDEN'));
});
