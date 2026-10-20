import {
  ACTIVITY_GROUPS,
  DEFAULT_PREFIXES,
  type ActivityPage,
  type ActivityQuery,
} from '../bo/activity.js';
import { decodeCursor, encodeCursor } from '../bo/review.js';
import type { Database } from '../db/config/database.js';
import type { ActivityRepository } from '../db/raw/repository/activity-repository.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/** The agency's activity log for admins: who did what and when. Read only. */
export class ActivityService {
  constructor(
    private readonly db: Pick<Database, 'transaction'>,
    private readonly repository: ActivityRepository,
  ) {}

  async list(actor: ProfileActor, query: ActivityQuery): Promise<ActivityPage> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    if (query.from && query.to && query.from > query.to)
      throw new AppError(400, 'INVALID_REQUEST', { fields: [{ path: 'to', code: 'rangeOrder' }] });
    return this.db.transaction(actor.agencyId, async (tx) => {
      const rows = await this.repository.list(
        tx,
        actor.agencyId,
        {
          prefixes: query.group ? ACTIVITY_GROUPS[query.group] : DEFAULT_PREFIXES,
          // The characters that mean something to LIKE are searched for as themselves.
          text: query.q ? query.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null,
          from: query.from ?? null,
          to: query.to ?? null,
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
}
