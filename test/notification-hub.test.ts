import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import {
  MAX_STREAMS_PER_ACCOUNT,
  NotificationHub,
  type ListenClient,
  type NotificationSignal,
} from '../src/notify/notification-hub.js';

const silent = pino({ level: 'silent' });
const AGENCY = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const payload = (agency: string, account: string) => JSON.stringify({ agency, account });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in for the database connection that listens: a test sends notifications and drops it. */
class FakeClient implements ListenClient {
  static all: FakeClient[] = [];
  static failNext = 0;
  handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  queries: string[] = [];
  ended = false;
  constructor() {
    FakeClient.all.push(this);
  }
  async connect() {
    if (FakeClient.failNext > 0) {
      FakeClient.failNext -= 1;
      throw new Error('connection refused');
    }
  }
  async query(sql: string) {
    this.queries.push(sql);
  }
  on(event: 'notification', handler: (message: { payload?: string | null }) => void): this;
  on(event: 'error' | 'end', handler: (error?: Error) => void): this;
  on(event: string, handler: unknown): this {
    (this.handlers[event] ??= []).push(handler as (arg?: unknown) => void);
    return this;
  }
  async end() {
    this.ended = true;
  }
  notify(text: string | null) {
    for (const handler of this.handlers.notification ?? [])
      (handler as (m: { payload?: string | null }) => void)({ payload: text });
  }
  drop() {
    for (const handler of this.handlers.end ?? []) handler();
  }
}

const make = () => {
  FakeClient.all = [];
  FakeClient.failNext = 0;
  return new NotificationHub(() => new FakeClient(), silent);
};

await test('a line added for an account reaches only that account, and an unsubscribed listener hears nothing', async () => {
  const hub = make();
  await hub.start();
  const mine: NotificationSignal[] = [];
  const theirs: NotificationSignal[] = [];
  const stop = hub.subscribe(AGENCY, ME, (s) => mine.push(s))!;
  hub.subscribe(AGENCY, OTHER, (s) => theirs.push(s));
  const client = FakeClient.all[0]!;
  assert.deepEqual(client.queries, ['LISTEN notifications']);

  client.notify(payload(AGENCY, ME));
  assert.deepEqual(mine, [{ agencyId: AGENCY, accountId: ME }]);
  assert.deepEqual(theirs, []);
  // The same account number in another agency is another account.
  client.notify(payload('44444444-4444-4444-8444-444444444444', ME));
  assert.equal(mine.length, 1);

  stop();
  client.notify(payload(AGENCY, ME));
  assert.equal(mine.length, 1);
  assert.equal(hub.count(AGENCY, ME), 0);
  await hub.stop();
});

await test('what is not a signal is ignored, and a listener that throws does not stop the others', async () => {
  const hub = make();
  await hub.start();
  const heard: string[] = [];
  hub.subscribe(AGENCY, ME, () => {
    throw new Error('boom');
  });
  hub.subscribe(AGENCY, ME, () => heard.push('second'));
  const client = FakeClient.all[0]!;
  for (const bad of [null, '', 'not json', JSON.stringify({ agency: 1, account: 2 }), '{}']) {
    client.notify(bad);
  }
  assert.deepEqual(heard, []);
  client.notify(payload(AGENCY, ME));
  assert.deepEqual(heard, ['second']);
  await hub.stop();
});

await test('an account may keep a few streams open, and no more', async () => {
  const hub = make();
  await hub.start();
  const stops: (() => void)[] = [];
  for (let i = 0; i < MAX_STREAMS_PER_ACCOUNT; i += 1) {
    const stop = hub.subscribe(AGENCY, ME, () => undefined);
    assert.ok(stop);
    stops.push(stop!);
  }
  assert.equal(
    hub.subscribe(AGENCY, ME, () => undefined),
    null,
  );
  // Another account is not affected, and closing one makes room.
  assert.ok(hub.subscribe(AGENCY, OTHER, () => undefined));
  stops[0]!();
  assert.ok(hub.subscribe(AGENCY, ME, () => undefined));
  await hub.stop();
});

await test('a connection that is lost is made again, and every listener checks once it is back', async () => {
  const hub = make();
  await hub.start();
  let checks = 0;
  hub.subscribe(AGENCY, ME, () => {
    checks += 1;
  });
  assert.equal(checks, 0, 'nothing has happened yet');
  FakeClient.all[0]!.drop();
  assert.equal(FakeClient.all[0]!.ended, true);
  // The retry comes after a pause; wait for it without making the test slow.
  for (let i = 0; i < 40 && FakeClient.all.length < 2; i += 1) await sleep(50);
  assert.equal(FakeClient.all.length, 2, 'a new connection was opened');
  await sleep(20);
  assert.equal(checks, 1, 'told, because lines may have been added while it was gone');
  FakeClient.all[1]!.notify(payload(AGENCY, ME));
  assert.equal(checks, 2);
  await hub.stop();
});

await test('a first connection that fails is retried, not thrown, and stopping ends everything', async () => {
  FakeClient.all = [];
  FakeClient.failNext = 1;
  const hub = new NotificationHub(() => new FakeClient(), silent);
  await hub.start();
  assert.equal(FakeClient.all.length, 1);
  for (let i = 0; i < 40 && FakeClient.all.length < 2; i += 1) await sleep(50);
  assert.equal(FakeClient.all.length, 2);
  await hub.stop();
  assert.equal(FakeClient.all[1]!.ended, true);
  // Nothing is opened after it was stopped.
  await sleep(100);
  assert.equal(FakeClient.all.length, 2);
});
