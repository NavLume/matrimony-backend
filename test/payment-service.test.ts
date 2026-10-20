import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaymentService, invoiceTypeOf, ledgerOf } from '../src/service/payment-service.js';
import type { PaymentRow } from '../src/bo/payment.js';
import type { PaymentUnit } from '../src/db/service/payment-db-service.js';
import { amountChangeSchema } from '../src/bo/payment.js';
import { AppError } from '../src/exception/app-error.js';
import { agency, accountId, otherAgency } from './fixtures.js';

const profile = {
  id: '11111111-1111-4111-8111-aaaaaaaaaaaa',
  memberCode: 'M100',
  fullName: 'Rahim Uddin',
  assignedAgentId: accountId,
  ownerAccountId: null,
};
const other = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const staff = (role: 'admin' | 'agent' = 'agent', id = accountId) => ({
  agencyId: agency,
  accountId: id,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const row = (patch: Partial<PaymentRow> = {}): PaymentRow => ({
  id: 'p1',
  stage: 'registration',
  amount: 2000,
  paidOn: '2026-10-16',
  method: 'cash',
  reference: null,
  note: null,
  connection: null,
  receivedBy: 'Salma',
  createdAt: '2026-10-16T00:00:00.000Z',
  invoice: null,
  voided: null,
  amountChanges: [],
  ...patch,
});

function fixture() {
  const inserted: unknown[] = [];
  const events: string[] = [];
  const files = new Map<string, Buffer>();
  const stored: PaymentRow[] = [row()];
  let invoiceKey: string | null = null;
  const unit = {
    profileById: async (_a: string, id: string) => (id === profile.id ? profile : null),
    ownProfile: async () => profile,
    agreements: async () => new Map([['registration' as const, 5000]]),
    setAgreement: async () => {},
    payments: async () => stored,
    payment: async (_a: string, _p: string, id: string) =>
      id === 'p1' || id === 'p2' ? { row: stored[0]!, invoiceKey } : null,
    acceptedFor: async () => false,
    insertPayment: async (_a: string, input: unknown) => {
      inserted.push(input);
    },
    setInvoice: async (_a: string, _id: string, file: { key: string }) => {
      if (invoiceKey) return false;
      invoiceKey = file.key;
      return true;
    },
    voidPayment: async () => true,
    changeAmount: async (_a: string, _id: string, amount: number) => {
      stored[0]!.amount = amount;
      return true;
    },
    appendEvent: async (event: { type: string }) => {
      events.push(event.type);
    },
  } as unknown as PaymentUnit;
  const service = new PaymentService(
    { inTransaction: async (_a, work) => work(unit) },
    {
      put: async (key, bytes) => {
        files.set(key, bytes);
      },
      get: async (key) => files.get(key) ?? null,
      delete: async (key) => {
        files.delete(key);
      },
    },
    { error: () => {} },
    () => new Date('2026-10-17T10:00:00.000Z'),
    () => 'p2',
  );
  return { service, inserted, events, files, stored };
}

const pdf = Buffer.from('%PDF-1.4 test');

await test('the balance is the agreed amount less what was paid, and a cancelled payment does not count', () => {
  const ledger = ledgerOf(
    profile,
    new Map([['registration', 5000]]),
    [
      row(),
      row({ id: 'p2', amount: 1500 }),
      row({ id: 'p3', amount: 900, voided: { at: 'x', reason: 'twice' } }),
    ],
    true,
  );
  assert.deepEqual(ledger.stages.registration, { agreed: 5000, paid: 3500, balance: 1500 });
  assert.deepEqual(ledger.stages.success, { agreed: null, paid: 0, balance: null });
});

await test('the total fee is the agreed total less everything paid in both stages', () => {
  const ledger = ledgerOf(
    profile,
    new Map([['total', 100000]]),
    [
      row({ stage: 'registration', amount: 30000 }),
      row({ id: 'p2', stage: 'success', amount: 20000 }),
      row({ id: 'p3', stage: 'success', amount: 5000, voided: { at: 'x', reason: 'twice' } }),
    ],
    true,
  );
  assert.deepEqual(ledger.total, { agreed: 100000, paid: 50000, balance: 50000 });
  assert.deepEqual(ledgerOf(profile, new Map(), [], true).total, {
    agreed: null,
    paid: 0,
    balance: null,
  });
});

await test('a client is told a payment was cancelled but not why', () => {
  const voided = row({ voided: { at: 'x', reason: 'entered twice' } });
  assert.equal(ledgerOf(profile, new Map(), [voided], false).payments[0]!.voided?.reason, null);
  assert.equal(
    ledgerOf(profile, new Map(), [voided], true).payments[0]!.voided?.reason,
    'entered twice',
  );
});

await test('a file must start with the bytes of the type it claims', () => {
  assert.equal(invoiceTypeOf(pdf, 'application/pdf'), 'application/pdf');
  assert.equal(invoiceTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), 'image/jpeg');
  assert.equal(invoiceTypeOf(Buffer.from('MZ not a pdf'), 'application/pdf'), null);
  assert.equal(invoiceTypeOf(pdf, 'text/html'), null);
});

await test('only the agent of the client, or an admin, can record; another agent finds nothing', async () => {
  const { service, inserted, events } = fixture();
  const input = {
    stage: 'registration' as const,
    amount: 2000,
    paidOn: '2026-10-16',
    method: 'cash' as const,
  };
  await service.record(staff(), profile.id, input, 'c1');
  assert.equal(inserted.length, 1);
  assert.deepEqual(events, ['payment.recorded']);
  await service.record(staff('admin', other), profile.id, input, 'c2');
  await assert.rejects(
    service.record(staff('agent', other), profile.id, input, 'c3'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    service.record({ agencyId: agency, accountId: other, role: 'member' }, profile.id, input, 'c4'),
    code(403, 'ROLE_FORBIDDEN'),
  );
});

await test('a payment dated in the future is refused', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.record(
      staff(),
      profile.id,
      { stage: 'registration', amount: 1, paidOn: '2030-01-01', method: 'cash' },
      'c',
    ),
    code(400, 'INVALID_REQUEST'),
  );
});

await test('the invoice is attached once, only when it is what it says it is', async () => {
  const { service, files } = fixture();
  await assert.rejects(
    service.attachInvoice(
      staff(),
      profile.id,
      'p1',
      Buffer.from('nope'),
      'application/pdf',
      undefined,
      'c',
    ),
    code(422, 'INVOICE_INVALID'),
  );
  assert.equal(files.size, 0);
  const done = await service.attachInvoice(
    staff(),
    profile.id,
    'p1',
    pdf,
    'application/pdf',
    'a/b\\receipt.pdf',
    'c',
  );
  assert.equal(files.size, 1);
  assert.ok(done);
  await assert.rejects(
    service.attachInvoice(staff(), profile.id, 'p1', pdf, 'application/pdf', undefined, 'c'),
    code(409, 'INVOICE_ALREADY_ATTACHED'),
  );
});

await test('only an admin cancels a payment', async () => {
  const { service, events } = fixture();
  await assert.rejects(
    service.voidPayment(staff(), profile.id, 'p1', 'typed wrong', 'c'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await service.voidPayment(staff('admin', other), profile.id, 'p1', 'typed wrong', 'c');
  assert.deepEqual(events, ['payment.voided']);
  await assert.rejects(
    service.voidPayment(staff('admin', other), profile.id, 'missing', 'typed wrong', 'c'),
    code(404, 'PAYMENT_NOT_FOUND'),
  );
  assert.ok(otherAgency);
});

await test('an admin can change a recorded amount with a reason; nobody else, not a cancelled payment, not to the same amount', async () => {
  const f = fixture();
  const change = (amount: number, who = staff('admin', other)) =>
    f.service.changeAmount(
      who,
      profile.id,
      'p1',
      amountChangeSchema.parse({ amount, reason: 'Typed wrong' }),
      'c',
    );
  await assert.rejects(() => change(2500, staff()), code(403, 'ROLE_FORBIDDEN'));
  await assert.rejects(() => change(2000), code(409, 'AMOUNT_UNCHANGED'));
  await assert.rejects(
    () =>
      f.service.changeAmount(
        staff('admin', other),
        profile.id,
        'missing',
        amountChangeSchema.parse({ amount: 1, reason: 'Typed wrong' }),
        'c',
      ),
    code(404, 'PAYMENT_NOT_FOUND'),
  );
  const ledger = await change(2500);
  assert.equal(ledger.payments[0]?.amount, 2500);
  assert.deepEqual(f.events.at(-1), 'payment.amount_changed');
  f.stored[0]!.voided = { at: 'x', reason: 'twice' };
  await assert.rejects(() => change(3000), code(409, 'PAYMENT_VOIDED'));
});

await test('the change history is for the office; a client sees only the amount as it now stands', () => {
  const changed = row({
    amountChanges: [{ from: 2000, to: 2500, reason: 'Typed wrong', at: 'x', by: 'Admin' }],
  });
  assert.equal(ledgerOf(profile, new Map(), [changed], true).payments[0]!.amountChanges.length, 1);
  assert.deepEqual(ledgerOf(profile, new Map(), [changed], false).payments[0]!.amountChanges, []);
});

await test('a new amount is whole taka within range and needs a reason of a few words', () => {
  assert.equal(amountChangeSchema.safeParse({ amount: 0, reason: 'abc' }).success, false);
  assert.equal(amountChangeSchema.safeParse({ amount: 10.5, reason: 'abc' }).success, false);
  assert.equal(amountChangeSchema.safeParse({ amount: 100, reason: 'a' }).success, false);
  assert.equal(
    amountChangeSchema.safeParse({ amount: 100, reason: 'Entered wrongly' }).success,
    true,
  );
});
