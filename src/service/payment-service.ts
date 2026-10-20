import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { canManage } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import {
  INVOICE_EXTENSION,
  INVOICE_TYPES,
  MAX_INVOICE_BYTES,
  PAYMENT_STAGES,
  type AgreementStage,
  type AmountChangeInput,
  type InvoiceType,
  type PaymentInput,
  type PaymentLedger,
  type PaymentRow,
} from '../bo/payment.js';
import type { PaymentProfile } from '../db/raw/repository/payment-repository.js';
import type { PaymentDbService, PaymentUnit } from '../db/service/payment-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { FileStorage } from '../storage/service/file-storage.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  | 'payment.recorded'
  | 'payment.agreement_set'
  | 'payment.invoice_added'
  | 'payment.voided'
  | 'payment.amount_changed'
>;

/** Whose payments: the signed-in member's own, or a client's, for staff who look after them. */
export type PaymentTarget = { kind: 'own' } | { kind: 'client'; profileId: string };

/** A file starts with the bytes of the type it claims, so a renamed file is refused. */
export function invoiceTypeOf(bytes: Buffer, declared: string): InvoiceType | null {
  const type = INVOICE_TYPES.find((candidate) => declared.toLowerCase().startsWith(candidate));
  if (!type) return null;
  const starts = (...head: number[]) => head.every((byte, i) => bytes[i] === byte);
  if (type === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46, 0x2d) ? type : null;
  if (type === 'image/jpeg') return starts(0xff, 0xd8, 0xff) ? type : null;
  return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ? type : null;
}

/** The ledger of a client: what was agreed, what was paid, and what is left, for each stage. */
export function ledgerOf(
  profile: Pick<PaymentProfile, 'id' | 'memberCode' | 'fullName'>,
  agreements: ReadonlyMap<AgreementStage, number>,
  payments: readonly PaymentRow[],
  showReasons: boolean,
): PaymentLedger {
  const stages = {} as PaymentLedger['stages'];
  for (const stage of PAYMENT_STAGES) {
    const paid = payments
      .filter((p) => p.stage === stage && !p.voided)
      .reduce((sum, p) => sum + p.amount, 0);
    const agreed = agreements.get(stage) ?? null;
    stages[stage] = { agreed, paid, balance: agreed === null ? null : agreed - paid };
  }
  const paidAll = payments.filter((p) => !p.voided).reduce((sum, p) => sum + p.amount, 0);
  const agreedTotal = agreements.get('total') ?? null;
  return {
    profile: { id: profile.id, memberCode: profile.memberCode, fullName: profile.fullName },
    stages,
    total: {
      agreed: agreedTotal,
      paid: paidAll,
      balance: agreedTotal === null ? null : agreedTotal - paidAll,
    },
    // The reason a payment was cancelled is for the office; the client only sees that it was.
    // The history of changes to an amount is for the office too; the client sees the amount as it now stands.
    payments: payments.map((p) =>
      showReasons
        ? p
        : {
            ...p,
            amountChanges: [],
            voided: p.voided ? { at: p.voided.at, reason: null } : null,
          },
    ),
  };
}

/**
 * The rules for payments recorded in the office (see bo/payment.ts). Files are stored here too.
 *
 * - Staff work on the clients they look after (an admin on all). Anyone else gets "not found", so an
 *   agent cannot learn that another agent's client exists.
 * - A member sees their own ledger only, and never the reason a payment was cancelled.
 * - Nothing is changed or deleted. Cancelling is for admins and needs a reason.
 */
export class PaymentService {
  constructor(
    private readonly db: Pick<PaymentDbService, 'inTransaction'>,
    private readonly storage: Pick<FileStorage, 'put' | 'get' | 'delete'>,
    private readonly logger: Pick<Logger, 'error'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async ledger(actor: ProfileActor, target: PaymentTarget): Promise<PaymentLedger> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target);
      return this.read(unit, actor, profile, target.kind === 'client');
    });
  }

  async setAgreement(
    actor: ProfileActor,
    profileId: string,
    stage: AgreementStage,
    amount: number,
    correlationId: string,
  ): Promise<PaymentLedger> {
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      await unit.setAgreement(actor.agencyId, profile.id, stage, amount, actor.accountId);
      await unit.appendEvent(this.event('payment.agreement_set', actor, profile.id, correlationId));
      return this.read(unit, actor, profile, true);
    });
  }

  async record(
    actor: ProfileActor,
    profileId: string,
    input: PaymentInput,
    correlationId: string,
  ): Promise<PaymentRow> {
    // A day ahead is allowed, for the difference between a phone's clock and the server's.
    const latest = new Date(this.now().getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(input.paidOn)) || input.paidOn > latest)
      throw new AppError(400, 'INVALID_REQUEST', { fields: [{ path: 'paidOn', code: 'invalid' }] });
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      if (
        input.connectionId &&
        !(await unit.acceptedFor(actor.agencyId, profile.id, input.connectionId))
      )
        throw new AppError(422, 'CONNECTION_NOT_ACCEPTED');
      const id = this.newId();
      await unit.insertPayment(actor.agencyId, {
        id,
        profileId: profile.id,
        stage: input.stage,
        amount: input.amount,
        paidOn: input.paidOn,
        method: input.method,
        reference: input.reference ?? null,
        note: input.note ?? null,
        interestId: input.connectionId ?? null,
        receivedBy: actor.accountId,
      });
      await unit.appendEvent(this.event('payment.recorded', actor, id, correlationId));
      const found = await unit.payment(actor.agencyId, profile.id, id);
      return found!.row;
    });
  }

  /** Attaches the invoice file to a payment, once. */
  async attachInvoice(
    actor: ProfileActor,
    profileId: string,
    paymentId: string,
    bytes: Buffer,
    declaredType: string,
    fileName: string | undefined,
    correlationId: string,
  ): Promise<PaymentRow> {
    if (bytes.length === 0 || bytes.length > MAX_INVOICE_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE');
    const type = invoiceTypeOf(bytes, declaredType);
    if (!type) throw new AppError(422, 'INVOICE_INVALID');
    const name = (fileName ?? '')
      .replace(/[\\/\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 120);
    const label = name || `invoice.${INVOICE_EXTENSION[type]}`;
    const key = `${actor.agencyId}/${profileId}/invoice-${paymentId}.${INVOICE_EXTENSION[type]}`;
    // Checked first, so a file is not stored for a payment that cannot take it.
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      await this.profileOf(unit, actor, { kind: 'client', profileId });
      const found = await unit.payment(actor.agencyId, profileId, paymentId);
      if (!found) throw new AppError(404, 'PAYMENT_NOT_FOUND');
      if (found.row.voided) throw new AppError(409, 'PAYMENT_VOIDED');
      if (found.invoiceKey) throw new AppError(409, 'INVOICE_ALREADY_ATTACHED');
    });
    await this.storage.put(key, bytes, type);
    try {
      return await this.db.inTransaction(actor.agencyId, async (unit) => {
        const done = await unit.setInvoice(actor.agencyId, paymentId, {
          key,
          name: label,
          mime: type,
          size: bytes.length,
        });
        if (!done) throw new AppError(409, 'INVOICE_ALREADY_ATTACHED');
        await unit.appendEvent(
          this.event('payment.invoice_added', actor, paymentId, correlationId),
        );
        return (await unit.payment(actor.agencyId, profileId, paymentId))!.row;
      });
    } catch (error) {
      await this.storage.delete(key).catch(() => {
        // Only the code is logged: a storage error can carry the bucket or the path.
        this.logger.error(
          { code: 'INVOICE_FILE_DELETE_FAILED' },
          'Could not delete an invoice file',
        );
      });
      throw error;
    }
  }

  async invoiceFile(
    actor: ProfileActor,
    target: PaymentTarget,
    paymentId: string,
  ): Promise<{ bytes: Buffer; mime: InvoiceType; name: string }> {
    const found = await this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, target);
      return unit.payment(actor.agencyId, profile.id, paymentId);
    });
    if (!found?.invoiceKey || !found.row.invoice) throw new AppError(404, 'INVOICE_NOT_FOUND');
    const bytes = await this.storage.get(found.invoiceKey);
    if (!bytes) throw new AppError(404, 'INVOICE_NOT_FOUND');
    return { bytes, mime: found.row.invoice.mime, name: found.row.invoice.name };
  }

  /** Cancels a payment, with a reason. Admins only; the record stays. */
  async voidPayment(
    actor: ProfileActor,
    profileId: string,
    paymentId: string,
    reason: string,
    correlationId: string,
  ): Promise<PaymentLedger> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      const found = await unit.payment(actor.agencyId, profile.id, paymentId);
      if (!found) throw new AppError(404, 'PAYMENT_NOT_FOUND');
      if (!(await unit.voidPayment(actor.agencyId, paymentId, actor.accountId, reason)))
        throw new AppError(409, 'PAYMENT_ALREADY_VOIDED');
      await unit.appendEvent(this.event('payment.voided', actor, paymentId, correlationId));
      return this.read(unit, actor, profile, true);
    });
  }

  /**
   * Changes the amount of a recorded payment, with a reason. Admins only. The earlier amount stays in the change
   * record, a cancelled payment cannot be changed, and every total follows the new amount.
   */
  async changeAmount(
    actor: ProfileActor,
    profileId: string,
    paymentId: string,
    input: AmountChangeInput,
    correlationId: string,
  ): Promise<PaymentLedger> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.profileOf(unit, actor, { kind: 'client', profileId });
      const found = await unit.payment(actor.agencyId, profile.id, paymentId);
      if (!found) throw new AppError(404, 'PAYMENT_NOT_FOUND');
      if (found.row.voided) throw new AppError(409, 'PAYMENT_VOIDED');
      if (found.row.amount === input.amount) throw new AppError(409, 'AMOUNT_UNCHANGED');
      if (
        !(await unit.changeAmount(
          actor.agencyId,
          paymentId,
          input.amount,
          actor.accountId,
          input.reason,
        ))
      )
        throw new AppError(409, 'AMOUNT_UNCHANGED');
      await unit.appendEvent(this.event('payment.amount_changed', actor, paymentId, correlationId));
      return this.read(unit, actor, profile, true);
    });
  }

  private async read(
    unit: PaymentUnit,
    actor: ProfileActor,
    profile: PaymentProfile,
    showReasons: boolean,
  ) {
    const [agreements, payments] = await Promise.all([
      unit.agreements(actor.agencyId, profile.id),
      unit.payments(actor.agencyId, profile.id),
    ]);
    return ledgerOf(profile, agreements, payments, showReasons);
  }

  /** The profile the actor may see payments of, or "not found". */
  private async profileOf(
    unit: PaymentUnit,
    actor: ProfileActor,
    target: PaymentTarget,
  ): Promise<PaymentProfile> {
    if (target.kind === 'own') {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return own;
    }
    if (actor.role === 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
    const profile = await unit.profileById(actor.agencyId, target.profileId);
    if (!profile || !canManage({ accountId: actor.accountId, role: actor.role }, profile))
      throw new AppError(404, 'PROFILE_NOT_FOUND');
    return profile;
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: this.newId(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      subjectId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    };
  }
}
