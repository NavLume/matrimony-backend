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
  let due: { account_id: string; storage_key: string }[] = [];
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
    { account_id: accountId, storage_key: `${agency}/p1/photo-1` },
    { account_id: accountId, storage_key: `${agency}/p1/cv-1.pdf` },
  ]);
  assert.equal(await f.process.eraseDue(agency, new Date('2026-11-01T00:00:00.000Z')), 1);
  assert.deepEqual(f.deletedFiles.sort(), [
    `${agency}/p1/cv-1.pdf`,
    `${agency}/p1/photo-1.full.webp`,
    `${agency}/p1/photo-1.thumb.webp`,
  ]);
  assert.equal(f.events.filter((event) => event.type === 'account.erased').length, 1);
});
