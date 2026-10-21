import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { AccountDeletionProcess } from '../src/process/account-deletion-process.js';
import { AppError } from '../src/exception/app-error.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import { agency, accountId } from './fixtures.js';

const actor = { agencyId: agency, accountId };
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

function fixture(
  options: {
    role?: 'admin' | 'agent' | 'member';
    hasPassword?: boolean;
    email?: string | null;
    phone?: string | null;
  } = {},
) {
  const checked: string[] = [];
  const events: WorkflowEvent[] = [];
  const removedSessions: string[] = [];
  const deletedFiles: string[] = [];
  const requested: string[] = [];
  let due: {
    account_id: string;
    file_key: string | null;
    file_kind: 'photo' | 'file' | null;
  }[] = [];
  let dueClients: {
    profile_id: string;
    file_key: string | null;
    file_kind: 'photo' | 'file' | null;
  }[] = [];
  let scheduled: Date | null = new Date('2026-10-21T00:00:00.000Z');
  let cancelled = true;
  const process = new AccountDeletionProcess(
    {
      account: async () => ({
        role: options.role ?? 'member',
        email: options.email === undefined ? 'rahim@example.com' : options.email,
        phone: options.phone ?? null,
        hasPassword: options.hasPassword ?? true,
        erased: false,
      }),
      request: async (_agency, id) => {
        requested.push(id);
        return new Date('2026-10-14T00:00:00.000Z');
      },
      cancel: async () => true,
      eraseDue: async () => due,
      scheduleClient: async () => scheduled,
      cancelClient: async () => cancelled,
      eraseDueClients: async () => dueClients,
    },
    {
      checkPassword: async (_agency, email, password) => {
        checked.push(`email:${email}`);
        if (password !== 'the right password') throw new AppError(401, 'INVALID_CREDENTIALS');
        return {} as never;
      },
      checkPhonePassword: async (_agency, phone, password) => {
        checked.push(`phone:${phone}`);
        if (password !== 'the right password') throw new AppError(401, 'INVALID_CREDENTIALS');
        return {} as never;
      },
    },
    {
      removeAll: async (id) => {
        removedSessions.push(id);
      },
    },
    {
      delete: async (key) => {
        deletedFiles.push(key);
      },
    },
    {
      record: async (event) => {
        events.push(event);
      },
    },
    pino({ level: 'silent' }),
  );
  return {
    process,
    checked,
    events,
    removedSessions,
    deletedFiles,
    requested,
    setDue: (rows: typeof due) => {
      due = rows;
    },
    setDueClients: (rows: typeof dueClients) => {
      dueClients = rows;
    },
    setScheduled: (value: Date | null) => {
      scheduled = value;
    },
    setCancelled: (value: boolean) => {
      cancelled = value;
    },
  };
}

await test('the password is asked again, and a wrong one changes nothing', async () => {
  const f = fixture();
  await assert.rejects(
    f.process.request(actor, 'a wrong password', 'req'),
    code(401, 'INVALID_CREDENTIALS'),
  );
  assert.deepEqual(f.requested, []);
  assert.deepEqual(f.removedSessions, []);
});

await test('a right password hides the account for 14 days, signs the person out and says when', async () => {
  const f = fixture();
  const result = await f.process.request(actor, 'the right password', 'req');
  assert.equal(result.scheduledFor, '2026-10-28T00:00:00.000Z');
  assert.deepEqual(f.removedSessions, [accountId]);
  assert.equal(f.events[0]?.type, 'account.deletion_requested');
});

await test('a phone-only member proves it with the phone password', async () => {
  const f = fixture({ email: null, phone: '+8801712345678' });
  await f.process.request(actor, 'the right password', 'req');
  assert.deepEqual(f.checked, ['phone:+8801712345678']);
});

await test('staff and accounts with no password are refused', async () => {
  await assert.rejects(
    fixture({ role: 'agent' }).process.request(actor, 'the right password', 'req'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    fixture({ hasPassword: false }).process.request(actor, 'x', 'req'),
    code(409, 'PASSWORD_REQUIRED'),
  );
});

await test('erasing deletes the photo sizes and the CV file, and records it once per account', async () => {
  const f = fixture();
  f.setDue([
    { account_id: accountId, file_key: `${agency}/p1/photo-1`, file_kind: 'photo' },
    { account_id: accountId, file_key: `${agency}/p1/cv-1.pdf`, file_kind: 'file' },
    // An identity document may be a JPG: it is one object, not a photo with size variants.
    { account_id: accountId, file_key: `${agency}/p1/id-1.jpg`, file_kind: 'file' },
    // An account with no files still comes back once, with no file.
    { account_id: accountId, file_key: null, file_kind: null },
  ]);
  assert.equal(await f.process.eraseDue(agency, new Date('2026-11-01T00:00:00.000Z')), 1);
  assert.deepEqual(f.deletedFiles.sort(), [
    `${agency}/p1/cv-1.pdf`,
    `${agency}/p1/id-1.jpg`,
    `${agency}/p1/photo-1.full.webp`,
    `${agency}/p1/photo-1.thumb.webp`,
  ]);
  assert.equal(f.events.filter((event) => event.type === 'account.erased').length, 1);
});

await test('an account with no files is still counted and recorded as erased', async () => {
  const f = fixture();
  f.setDue([{ account_id: accountId, file_key: null, file_kind: null }]);
  assert.equal(await f.process.eraseDue(agency, new Date('2026-11-01T00:00:00.000Z')), 1);
  assert.deepEqual(f.deletedFiles, []);
  assert.equal(f.events.filter((event) => event.type === 'account.erased').length, 1);
});

await test('asking to erase a client with no login hides them for 7 days and records who asked', async () => {
  const f = fixture();
  const erasesOn = await f.process.scheduleClient(
    actor,
    'profile-2',
    'The family asked by phone',
    'req',
  );
  assert.equal(erasesOn?.toISOString(), '2026-10-28T00:00:00.000Z');
  const event = f.events.find((e) => e.type === 'client.erasure_scheduled');
  assert.equal(event?.actorId, accountId);
  assert.equal(event?.subjectId, 'profile-2');
  assert.deepEqual(f.deletedFiles, []);
});

await test('a profile that cannot be scheduled changes nothing and records nothing', async () => {
  const f = fixture();
  f.setScheduled(null);
  assert.equal(await f.process.scheduleClient(actor, 'profile-3', 'a reason here', 'req'), null);
  assert.deepEqual(f.events, []);
});

await test('cancelling brings a scheduled client back and records it; nothing scheduled records nothing', async () => {
  const f = fixture();
  assert.equal(await f.process.cancelClient(actor, 'profile-2', 'req'), true);
  assert.equal(f.events[0]?.type, 'client.erasure_cancelled');
  const g = fixture();
  g.setCancelled(false);
  assert.equal(await g.process.cancelClient(actor, 'profile-2', 'req'), false);
  assert.deepEqual(g.events, []);
});

await test('the hourly round erases the clients whose 7 days are over, deletes their files and records it', async () => {
  const f = fixture();
  f.setDueClients([
    { profile_id: 'profile-2', file_key: null, file_kind: null },
    { profile_id: 'profile-2', file_key: `${agency}/p2/id-9.png`, file_kind: 'file' },
  ]);
  assert.equal(await f.process.eraseDue(agency, new Date('2026-11-01T00:00:00.000Z')), 1);
  assert.deepEqual(f.deletedFiles, [`${agency}/p2/id-9.png`]);
  const event = f.events.find((e) => e.type === 'client.erased');
  assert.equal(event?.actorId, null);
  assert.equal(event?.subjectId, 'profile-2');
});
