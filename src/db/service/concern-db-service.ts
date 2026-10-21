import type { WorkflowEvent } from '../../bo/event.js';
import type { Database, Transaction } from '../config/database.js';
import type { ConcernRepository } from '../raw/repository/concern-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/**
 * Everything the private concerns may do, bound to one open transaction, so a concern, its inbox lines and its
 * event are kept together.
 */
export interface ConcernUnit {
  profileByCode: ConcernRepositoryBound['profileByCode'];
  clientForRecording: ConcernRepositoryBound['clientForRecording'];
  insertForClient: ConcernRepositoryBound['insertForClient'];
  reportable: ConcernRepositoryBound['reportable'];
  insert: ConcernRepositoryBound['insert'];
  mine: ConcernRepositoryBound['mine'];
  list: ConcernRepositoryBound['list'];
  resolve: ConcernRepositoryBound['resolve'];
  tellStaff: ConcernRepositoryBound['tellStaff'];
  tellReporter: ConcernRepositoryBound['tellReporter'];
  appendEvent(event: WorkflowEvent): Promise<void>;
}

type Bound<F> = F extends (tx: Transaction, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type ConcernRepositoryBound = { [K in keyof ConcernRepository]: Bound<ConcernRepository[K]> };

export class ConcernDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: ConcernRepository,
    private readonly events: EventRepository,
  ) {}

  inTransaction<T>(agencyId: string, work: (unit: ConcernUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ConcernUnit {
    const repo = this.repository;
    return {
      profileByCode: (...a) => repo.profileByCode(tx, ...a),
      clientForRecording: (...a) => repo.clientForRecording(tx, ...a),
      insertForClient: (...a) => repo.insertForClient(tx, ...a),
      reportable: (...a) => repo.reportable(tx, ...a),
      insert: (...a) => repo.insert(tx, ...a),
      mine: (...a) => repo.mine(tx, ...a),
      list: (...a) => repo.list(tx, ...a),
      resolve: (...a) => repo.resolve(tx, ...a),
      tellStaff: (...a) => repo.tellStaff(tx, ...a),
      tellReporter: (...a) => repo.tellReporter(tx, ...a),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
