import { canManage } from '../bo/access.js';
import type {
  AgentIntroductions,
  ConnectionHistory,
  IntroductionRange,
} from '../bo/introduction.js';
import type { IntroductionDbService } from '../db/service/introduction-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/**
 * The introduction ledger (see bo/introduction.ts): what happened to one proposal, for an admin or an agent who
 * looks after either side; and each agent's introductions, for an admin. A record only: how credit is shared is
 * each agency's own decision.
 */
export class IntroductionService {
  constructor(private readonly db: Pick<IntroductionDbService, 'inTransaction'>) {}

  async history(actor: ProfileActor, connectionId: string): Promise<ConnectionHistory> {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const parties = await unit.parties(actor.agencyId, connectionId);
      const who = { accountId: actor.accountId, role: actor.role };
      if (
        !parties ||
        !(
          canManage(who, { assignedAgentId: parties.senderAgent }) ||
          canManage(who, { assignedAgentId: parties.recipientAgent })
        )
      )
        throw new AppError(404, 'CONNECTION_NOT_FOUND');
      return unit.history(actor.agencyId, connectionId);
    });
  }

  async byAgent(actor: ProfileActor, range: IntroductionRange): Promise<AgentIntroductions[]> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, (unit) =>
      unit.byAgent(actor.agencyId, range.from ?? null, range.to ?? null),
    );
  }
}
