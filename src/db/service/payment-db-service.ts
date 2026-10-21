import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { PaymentRepository } from '../raw/repository/payment-repository.js';

/**
 * Everything the payment records may do, bound to one open transaction, so a payment and its event
 * are stored together.
 */
export interface PaymentUnit {
  profileById: PaymentRepositoryBound['profileById'];
  ownProfile: PaymentRepositoryBound['ownProfile'];
  agreements: PaymentRepositoryBound['agreements'];
  setAgreement: PaymentRepositoryBound['setAgreement'];
  payments: PaymentRepositoryBound['payments'];
  payment: PaymentRepositoryBound['payment'];
  acceptedFor: PaymentRepositoryBound['acceptedFor'];
  insertPayment: PaymentRepositoryBound['insertPayment'];
  setInvoice: PaymentRepositoryBound['setInvoice'];
  voidPayment: PaymentRepositoryBound['voidPayment'];
  deletePayment: PaymentRepositoryBound['deletePayment'];
  changeAmount: PaymentRepositoryBound['changeAmount'];
  appendEvent(event: WorkflowEvent): Promise<void>;
}

/** A repository method without its leading transaction argument. */
type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type PaymentRepositoryBound = { [K in keyof PaymentRepository]: Bound<PaymentRepository[K]> };

export class PaymentDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: PaymentRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: PaymentUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): PaymentUnit {
    const repo = this.repository;
    return {
      profileById: (...a) => repo.profileById(tx, ...a),
      ownProfile: (...a) => repo.ownProfile(tx, ...a),
      agreements: (...a) => repo.agreements(tx, ...a),
      setAgreement: (...a) => repo.setAgreement(tx, ...a),
      payments: (...a) => repo.payments(tx, ...a),
      payment: (...a) => repo.payment(tx, ...a),
      acceptedFor: (...a) => repo.acceptedFor(tx, ...a),
      insertPayment: (...a) => repo.insertPayment(tx, ...a),
      setInvoice: (...a) => repo.setInvoice(tx, ...a),
      voidPayment: (...a) => repo.voidPayment(tx, ...a),
      deletePayment: (...a) => repo.deletePayment(tx, ...a),
      changeAmount: (...a) => repo.changeAmount(tx, ...a),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
