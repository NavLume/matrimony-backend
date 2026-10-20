import { decodeCursor, encodeCursor } from '../bo/review.js';
import {
  PROPOSAL_STATUSES,
  type CancelledPage,
  type CancelledQuery,
  type ClientMoney,
  type NetworkReport,
  type SuccessfulPage,
  type SuccessfulQuery,
  type ProposalListQuery,
  type ProposalPage,
  type ProposalStatus,
  type ReportBasis,
  type SummaryQuery,
  type SummaryReport,
} from '../bo/report.js';
import type { Database } from '../db/config/database.js';
import type { ReportRepository } from '../db/raw/repository/report-repository.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/** The most proposals drawn in the agency-wide picture; a client's own picture draws every one. */
const MAX_DRAWN = 60;

/** Bangladesh's current date, `YYYY-MM-DD`. */
const dhakaToday = (now: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(now);

/** The first day of a year and of the next one, and the 12 months in between. */
export function yearSpan(basis: ReportBasis, year: number) {
  const startMonth = basis === 'fiscal' ? 7 : 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const months: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const index = startMonth - 1 + i;
    months.push(`${year + Math.floor(index / 12)}-${pad((index % 12) + 1)}`);
  }
  return {
    from: `${year}-${pad(startMonth)}-01`,
    to: `${year + (basis === 'fiscal' ? 1 : 1)}-${pad(startMonth)}-01`,
    months,
  };
}

/** The year the date falls in, named by the year it starts in. */
export function yearOf(basis: ReportBasis, today: string) {
  const [year, month] = today.split('-').map(Number) as [number, number];
  return basis === 'fiscal' && month < 7 ? year - 1 : year;
}

/** What the admin reads: numbers over everything the agency holds. Admins only, read only. */
export class ReportService {
  constructor(
    private readonly db: Pick<Database, 'transaction'>,
    private readonly repository: ReportRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async summary(actor: ProfileActor, query: SummaryQuery): Promise<SummaryReport> {
    this.requireAdmin(actor);
    const { basis } = query;
    const year = query.year ?? yearOf(basis, dhakaToday(this.now()));
    const span = yearSpan(basis, year);
    const repo = this.repository;
    const agencyId = actor.agencyId;
    return this.db.transaction(agencyId, async (tx) => {
      const [
        roles,
        profiles,
        waiting,
        proposals,
        months,
        agents,
        yearly,
        monthly,
        clients,
        totals,
        matched,
      ] = await Promise.all([
        repo.accountsByRole(tx, agencyId),
        repo.profilesByStatus(tx, agencyId),
        repo.waiting(tx, agencyId),
        repo.proposalCounts(tx, agencyId),
        repo.months(tx, agencyId),
        repo.agents(tx, agencyId, span.from, span.to),
        repo.yearlyMoney(tx, agencyId, basis),
        repo.monthlyMoney(tx, agencyId, span.from, span.to),
        repo.clientMoney(tx, agencyId),
        repo.moneyTotals(tx, agencyId),
        repo.matchedClients(tx, agencyId),
      ]);

      const byStatus = Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s, 0])) as Record<
        ProposalStatus,
        number
      >;
      let contactShared = 0;
      let bothShared = 0;
      for (const row of proposals) {
        byStatus[row.status] = row.n;
        contactShared += row.shared;
        bothShared += row.bothShared;
      }
      const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
      const profilesByStatus: Record<string, number> = {};
      let clientsTotal = 0;
      let assisted = 0;
      for (const row of profiles) {
        profilesByStatus[row.status] = (profilesByStatus[row.status] ?? 0) + row.n;
        clientsTotal += row.n;
        if (row.serviceMode === 'assisted') assisted += row.n;
      }
      const monthlyByKey = new Map<string, { registration: number; success: number }>();
      for (const row of monthly) {
        const entry = monthlyByKey.get(row.month) ?? { registration: 0, success: 0 };
        entry[row.stage] += row.total;
        monthlyByKey.set(row.month, entry);
      }
      const monthlyFilled = span.months.map((month) => ({
        month,
        registration: monthlyByKey.get(month)?.registration ?? 0,
        success: monthlyByKey.get(month)?.success ?? 0,
      }));
      // The years offered include this one and the chosen one even when nothing was paid in them.
      const years = [
        ...new Set([...yearly.map((y) => y.year), year, yearOf(basis, dhakaToday(this.now()))]),
      ].sort((a, b) => a - b);

      return {
        basis,
        year,
        years,
        people: {
          members: roles.member ?? 0,
          clients: clientsTotal,
          assistedClients: assisted,
          agents: roles.agent ?? 0,
          admins: roles.admin ?? 0,
          profilesByStatus,
        },
        waiting,
        proposals: { total, byStatus, contactShared, bothShared },
        funnel: {
          made: total - byStatus.withdrawn,
          accepted: byStatus.accepted,
          contactShared,
          matchedClients: matched,
        },
        months,
        agents,
        money: {
          yearly,
          monthly: monthlyFilled,
          yearTotals: {
            registration: monthlyFilled.reduce((s, m) => s + m.registration, 0),
            success: monthlyFilled.reduce((s, m) => s + m.success, 0),
          },
          agreedTotal: totals.agreed,
          paidTotal: totals.paid,
          clients,
        },
      };
    });
  }

  /** Every proposal, newest first, narrowed by status or a search for a member code or name. */
  async proposals(actor: ProfileActor, query: ProposalListQuery): Promise<ProposalPage> {
    this.requireAdmin(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.transaction(actor.agencyId, async (tx) => {
      const rows = await this.repository.proposals(
        tx,
        actor.agencyId,
        {
          status: query.status ?? null,
          // The characters that mean something to LIKE are searched for as themselves.
          text: query.q ? query.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null,
        },
        { limit: query.limit, after },
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map((item) => {
          const row: Partial<typeof item> = { ...item };
          delete row.position;
          return row as Omit<typeof item, 'position'>;
        }),
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
      };
    });
  }

  /** The per-client money table narrowed by a search for a member (name or code) or an agent. */
  async clientMoney(actor: ProfileActor, text: string | null): Promise<ClientMoney[]> {
    this.requireAdmin(actor);
    return this.db.transaction(actor.agencyId, (tx) =>
      this.repository.clientMoney(
        tx,
        actor.agencyId,
        text ? text.replace(/[\\%_]/g, (c) => `\\${c}`) : null,
      ),
    );
  }

  /** Payments that were cancelled, with who cancelled them and why. They never count in any total. */
  async cancelledPayments(actor: ProfileActor, query: CancelledQuery): Promise<CancelledPage> {
    this.requireAdmin(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.transaction(actor.agencyId, async (tx) => {
      const [rows, totals] = await Promise.all([
        this.repository.cancelled(
          tx,
          actor.agencyId,
          { text: query.q ? query.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null },
          { limit: query.limit, after },
        ),
        this.repository.cancelledTotals(tx, actor.agencyId),
      ]);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map((item) => {
          const row: Partial<typeof item> = { ...item };
          delete row.position;
          return row as Omit<typeof item, 'position'>;
        }),
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
        totals,
      };
    });
  }

  /** Accepted proposals with everything known about each: both clients, agents, dates, meetings and money. */
  async successful(actor: ProfileActor, query: SuccessfulQuery): Promise<SuccessfulPage> {
    this.requireAdmin(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.transaction(actor.agencyId, async (tx) => {
      const [rows, totals] = await Promise.all([
        this.repository.successful(
          tx,
          actor.agencyId,
          {
            text: query.q ? query.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null,
            matched: query.matched === undefined ? null : query.matched === 'true',
          },
          { limit: query.limit, after },
        ),
        this.repository.successfulTotals(tx, actor.agencyId),
      ]);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map((item) => {
          const row: Partial<typeof item> = { ...item };
          delete row.position;
          return row as Omit<typeof item, 'position'>;
        }),
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
        totals,
      };
    });
  }

  /** Who is connected with whom: one client's proposals, or the agency's accepted ones. */
  async network(actor: ProfileActor, client: string | null): Promise<NetworkReport> {
    this.requireAdmin(actor);
    return this.db.transaction(actor.agencyId, async (tx) => {
      const limit = client ? 200 : MAX_DRAWN + 1;
      const found = await this.repository.edges(tx, actor.agencyId, client, limit);
      const truncated = !client && found.length > MAX_DRAWN;
      const edges = truncated ? found.slice(0, MAX_DRAWN) : found;
      const ids = [
        ...new Set([...(client ? [client] : []), ...edges.flatMap((e) => [e.from, e.to])]),
      ];
      const nodes = await this.repository.nodes(tx, actor.agencyId, ids);
      if (client && !nodes.some((n) => n.profileId === client))
        throw new AppError(404, 'PROFILE_NOT_FOUND');
      return { centre: client, nodes, edges, truncated };
    });
  }

  private requireAdmin(actor: ProfileActor) {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}
