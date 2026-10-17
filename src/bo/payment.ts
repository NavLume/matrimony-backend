import { z } from 'zod';

/**
 * Payments recorded in the office (decided with the friend on 16 October 2026). Money is paid outside
 * the platform; the platform keeps what each client agreed to pay and what they paid.
 *
 * - Two stages: `registration` (the fee before a match) and `success` (the fee after a match).
 * - A client has an agreed amount per stage, set by their agent (or an admin). It is a record of what
 *   was agreed, not a charge.
 * - A payment is never changed or deleted. An admin cancels a mistaken one with a reason and a new one
 *   is entered. The invoice file (PDF, JPG or PNG, up to 5 MB) is attached once.
 * - An agent sees the payments of their own clients; a client sees their own; an admin sees all.
 */
const fail = (key: string) => ({ error: key });

export const PAYMENT_STAGES = ['registration', 'success'] as const;
export type PaymentStage = (typeof PAYMENT_STAGES)[number];
export const PAYMENT_METHODS = ['cash', 'bank', 'bkash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MAX_PAYMENT_AMOUNT = 100_000_000;
export const MAX_INVOICE_BYTES = 5 * 1024 * 1024;
export const INVOICE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];
export const INVOICE_EXTENSION: Record<InvoiceType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const amount = (min: number) =>
  z
    .number(fail('invalid'))
    .int(fail('invalid'))
    .min(min, fail('outOfRange'))
    .max(MAX_PAYMENT_AMOUNT, fail('outOfRange'));
const text = (max: number) =>
  z
    .string(fail('invalid'))
    .trim()
    .max(max, fail('tooLong'))
    .transform((value) => (value === '' ? undefined : value))
    .optional();

export const paymentInputSchema = z
  .object({
    stage: z.enum(PAYMENT_STAGES, fail('invalidOption')),
    amount: amount(1),
    paidOn: z.string(fail('invalid')).regex(/^\d{4}-\d{2}-\d{2}$/, fail('invalid')),
    method: z.enum(PAYMENT_METHODS, fail('invalidOption')),
    reference: text(60),
    note: text(300),
    /** For a success fee: the accepted proposal it came from. */
    connectionId: z.uuid(fail('invalid')).optional(),
  })
  .strict()
  .refine((value) => !value.connectionId || value.stage === 'success', {
    path: ['connectionId'],
    message: 'invalid',
  });
export type PaymentInput = z.output<typeof paymentInputSchema>;

export const agreementInputSchema = z.object({ amount: amount(0) }).strict();
export const stageParamSchema = z.enum(PAYMENT_STAGES, fail('invalidOption'));

export const voidInputSchema = z
  .object({
    reason: z.string(fail('required')).trim().min(3, fail('tooShort')).max(300, fail('tooLong')),
  })
  .strict();

export interface PaymentRow {
  id: string;
  stage: PaymentStage;
  amount: number;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
  /** The accepted proposal a success fee came from. */
  connection: { id: string; memberCode: string; fullName: string } | null;
  receivedBy: string;
  createdAt: string;
  invoice: { name: string; mime: InvoiceType; size: number } | null;
  /** When it was cancelled and why. The reason is for the office; a client sees null. */
  voided: { at: string; reason: string | null } | null;
}

export interface StageSummary {
  agreed: number | null;
  paid: number;
  /** The agreed amount less what was paid. Null while no amount is agreed. */
  balance: number | null;
}

export interface PaymentLedger {
  profile: { id: string; memberCode: string; fullName: string };
  stages: Record<PaymentStage, StageSummary>;
  payments: PaymentRow[];
}
