import type { InvoiceType, PaymentMethod, PaymentRow, PaymentStage } from '../../../bo/payment.js';
import type { Transaction } from '../../config/database.js';

export interface PaymentProfile {
  id: string;
  memberCode: string;
  fullName: string;
  assignedAgentId: string | null;
  ownerAccountId: string | null;
}

type Row = Record<string, unknown>;

const PAYMENT_COLUMNS = `p.id, p.stage, p.amount::bigint AS amount, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on,
       p.method, p.reference, p.note, p.created_at, p.invoice_name, p.invoice_mime, p.invoice_size,
       p.voided_at, p.void_reason, p.interest_id, a.display_name AS received_by_name,
       o.member_code AS other_code, o.full_name AS other_name`;

const PAYMENT_JOINS = `FROM matrimony.client_payments p
  JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.received_by
  LEFT JOIN matrimony.interests i ON i.agency_id = p.agency_id AND i.id = p.interest_id
  LEFT JOIN matrimony.member_profiles o ON o.agency_id = p.agency_id
        AND o.id = CASE WHEN i.sender_profile_id = p.profile_id THEN i.recipient_profile_id ELSE i.sender_profile_id END`;

const paymentRow = (row: Row): PaymentRow => ({
  id: row.id as string,
  stage: row.stage as PaymentStage,
  amount: Number(row.amount),
  paidOn: row.paid_on as string,
  method: row.method as PaymentMethod,
  reference: (row.reference as string | null) ?? null,
  note: (row.note as string | null) ?? null,
  connection: row.interest_id
    ? {
        id: row.interest_id as string,
        memberCode: (row.other_code as string | null) ?? '',
        fullName: (row.other_name as string | null) ?? '',
      }
    : null,
  receivedBy: row.received_by_name as string,
  createdAt: (row.created_at as Date).toISOString(),
  invoice: row.invoice_name
    ? {
        name: row.invoice_name as string,
        mime: row.invoice_mime as InvoiceType,
        size: row.invoice_size as number,
      }
    : null,
  voided: row.voided_at
    ? { at: (row.voided_at as Date).toISOString(), reason: row.void_reason as string }
    : null,
});

/** What the office recorded: agreements, payments and their invoice files. Never deletes a row. */
export class PaymentRepository {
  async profileById(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT id, member_code, full_name, assigned_agent_id, owner_account_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    return this.profile(result.rows[0]);
  }

  async ownProfile(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(
      `SELECT id, member_code, full_name, assigned_agent_id, owner_account_id
         FROM matrimony.member_profiles WHERE agency_id = $1 AND owner_account_id = $2`,
      [agencyId, accountId],
    );
    return this.profile(result.rows[0]);
  }

  private profile(row: Row | undefined): PaymentProfile | null {
    return row
      ? {
          id: row.id as string,
          memberCode: row.member_code as string,
          fullName: row.full_name as string,
          assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
          ownerAccountId: (row.owner_account_id as string | null) ?? null,
        }
      : null;
  }

  async agreements(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT stage, amount::bigint AS amount FROM matrimony.client_agreements
        WHERE agency_id = $1 AND profile_id = $2`,
      [agencyId, profileId],
    );
    return new Map(
      (result.rows as Row[]).map((row) => [row.stage as PaymentStage, Number(row.amount)]),
    );
  }

  async setAgreement(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    stage: PaymentStage,
    amount: number,
    by: string,
  ) {
    await tx.query(
      `INSERT INTO matrimony.client_agreements (agency_id, profile_id, stage, amount, set_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agency_id, profile_id, stage) DO UPDATE
         SET amount = EXCLUDED.amount, set_by = EXCLUDED.set_by, updated_at = now()`,
      [agencyId, profileId, stage, amount, by],
    );
  }

  async payments(tx: Transaction, agencyId: string, profileId: string) {
    const result = await tx.query(
      `SELECT ${PAYMENT_COLUMNS} ${PAYMENT_JOINS}
        WHERE p.agency_id = $1 AND p.profile_id = $2
        ORDER BY p.paid_on DESC, p.created_at DESC, p.id`,
      [agencyId, profileId],
    );
    return (result.rows as Row[]).map(paymentRow);
  }

  async payment(tx: Transaction, agencyId: string, profileId: string, id: string) {
    const result = await tx.query(
      `SELECT ${PAYMENT_COLUMNS}, p.invoice_key ${PAYMENT_JOINS}
        WHERE p.agency_id = $1 AND p.profile_id = $2 AND p.id = $3`,
      [agencyId, profileId, id],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? { row: paymentRow(row), invoiceKey: (row.invoice_key as string | null) ?? null }
      : null;
  }

  /** Whether the proposal is accepted and one of its two sides is this profile. */
  async acceptedFor(tx: Transaction, agencyId: string, profileId: string, interestId: string) {
    const result = await tx.query(
      `SELECT 1 FROM matrimony.interests
        WHERE agency_id = $1 AND id = $2 AND status = 'accepted'
          AND (sender_profile_id = $3 OR recipient_profile_id = $3)`,
      [agencyId, interestId, profileId],
    );
    return result.rows.length > 0;
  }

  async insertPayment(
    tx: Transaction,
    agencyId: string,
    input: {
      id: string;
      profileId: string;
      stage: PaymentStage;
      amount: number;
      paidOn: string;
      method: PaymentMethod;
      reference: string | null;
      note: string | null;
      interestId: string | null;
      receivedBy: string;
    },
  ) {
    await tx.query(
      `INSERT INTO matrimony.client_payments
         (agency_id, id, profile_id, stage, amount, paid_on, method, reference, note, interest_id, received_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)`,
      [
        agencyId,
        input.id,
        input.profileId,
        input.stage,
        input.amount,
        input.paidOn,
        input.method,
        input.reference,
        input.note,
        input.interestId,
        input.receivedBy,
      ],
    );
  }

  /** Attaches the file, once. False when the payment already has one. */
  async setInvoice(
    tx: Transaction,
    agencyId: string,
    id: string,
    file: { key: string; name: string; mime: InvoiceType; size: number },
  ) {
    const result = await tx.query(
      `UPDATE matrimony.client_payments
          SET invoice_key = $3, invoice_name = $4, invoice_mime = $5, invoice_size = $6
        WHERE agency_id = $1 AND id = $2 AND invoice_key IS NULL AND voided_at IS NULL
        RETURNING id`,
      [agencyId, id, file.key, file.name, file.mime, file.size],
    );
    return result.rows.length > 0;
  }

  /** Cancels a payment, once. The row stays. */
  async voidPayment(tx: Transaction, agencyId: string, id: string, by: string, reason: string) {
    const result = await tx.query(
      `UPDATE matrimony.client_payments
          SET voided_at = now(), voided_by = $3, void_reason = $4
        WHERE agency_id = $1 AND id = $2 AND voided_at IS NULL
        RETURNING id`,
      [agencyId, id, by, reason],
    );
    return result.rows.length > 0;
  }
}
