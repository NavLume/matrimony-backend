import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { PushProcess } from '../src/process/push-process.js';
import { pushBody } from '../src/push/messages.js';
import type { PushMessage, PushTarget } from '../src/push/push-sender.js';
import { agency, accountId } from './fixtures.js';

type Device = { id: string; platform: 'ios' | 'android'; token: string; locale: 'bn' | 'en' };

function fixture(kinds: string[], devices: Device[], outcome: 'sent' | 'invalid_token' = 'sent') {
  const sent: { target: PushTarget; message: PushMessage }[] = [];
  const forgotten: string[] = [];
  let failing = false;
  const process = new PushProcess(
    {
      register: async () => {},
      unregister: async () => {},
      forget: async (_agency, id) => {
        forgotten.push(id);
      },
      take: async () => {
        if (failing) throw new Error('database down');
        return { kinds, devices };
      },
    },
    {
      send: async (target, message) => {
        sent.push({ target, message });
        return outcome;
      },
    },
    async () => 'Marriage Solution BD',
    pino({ level: 'silent' }),
  );
  return {
    process,
    sent,
    forgotten,
    fail: () => {
      failing = true;
    },
  };
}

const phone: Device = { id: 'd1', platform: 'android', token: 'x'.repeat(30), locale: 'en' };

await test('one line gives one short push that names the kind and nothing else', async () => {
  const f = fixture(['interest.received'], [phone]);
  assert.equal(await f.process.dispatch(agency, accountId), 1);
  assert.deepEqual(f.sent[0]?.message, {
    title: 'Marriage Solution BD',
    body: 'You have a new connection request.',
  });
});

await test("several lines become one push with a count, in the phone's language", async () => {
  const f = fixture(
    ['interest.received', 'profile.review_decided'],
    [{ ...phone, id: 'd2', locale: 'bn' }],
  );
  await f.process.dispatch(agency, accountId);
  assert.match(f.sent[0]!.message.body, /2/);
  assert.match(f.sent[0]!.message.body, /[ঀ-৿]/);
});

await test('nothing is sent when there are no lines or no phones', async () => {
  assert.equal(await fixture([], [phone]).process.dispatch(agency, accountId), 0);
  assert.equal(await fixture(['interest.received'], []).process.dispatch(agency, accountId), 0);
});

await test('a phone that is gone is forgotten, and a failure never throws', async () => {
  const f = fixture(['interest.received'], [phone], 'invalid_token');
  assert.equal(await f.process.dispatch(agency, accountId), 0);
  assert.deepEqual(f.forgotten, ['d1']);
  f.fail();
  assert.equal(await f.process.dispatch(agency, accountId), 0);
});

await test('an unknown kind falls back to a generic line in both languages', () => {
  assert.match(pushBody('something.new', 'en'), /new notice/);
  assert.match(pushBody('something.new', 'bn'), /[ঀ-৿]/);
});
