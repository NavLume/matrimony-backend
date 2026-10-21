import type { Attention, AttentionItem, Workload } from '../bo/attention.js';
import type { AttentionDbService } from '../db/service/attention-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

const DAY = 24 * 3600 * 1000;

/** One line per agent: published clients, overdue items about them, and how long the oldest has waited. */
export function workloadOf(
  agents: readonly { agentId: string; displayName: string; clients: number }[],
  items: readonly AttentionItem[],
  now: Date,
): Workload[] {
  return agents.map((agent) => {
    const mine = items.filter((item) => item.agent?.id === agent.agentId);
    const oldest = mine.reduce<number | null>((best, item) => {
      const days = Math.floor((now.getTime() - Date.parse(item.since)) / DAY);
      return best === null || days > best ? days : best;
    }, null);
    return { ...agent, overdue: mine.length, oldestDays: oldest };
  });
}

/**
 * What has waited too long (see bo/attention.ts). Staff only: an agent reads the items about their own clients,
 * an admin reads everything and a workload line for each agent.
 */
export class AttentionService {
  constructor(
    private readonly db: Pick<AttentionDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(actor: ProfileActor): Promise<Attention> {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const admin = actor.role === 'admin';
      const limits = await unit.limits(actor.agencyId);
      const items = await unit.items(actor.agencyId, admin ? null : actor.accountId, limits);
      const workload = admin
        ? workloadOf(await unit.agents(actor.agencyId), items, this.now())
        : [];
      return { items, workload };
    });
  }
}
