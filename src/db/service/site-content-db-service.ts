import type { WorkflowEvent } from '../../bo/event.js';
import type { Database } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { SiteContentRepository } from '../raw/repository/site-content-repository.js';

/** The unit of work for the public site's content. */
export class SiteContentDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: SiteContentRepository,
    private readonly events: EventRepository,
  ) {}

  readConfig(agencyId: string) {
    return this.db.transaction(agencyId, async (tx) => ({
      config: await this.repository.config(tx, agencyId),
      published: await this.repository.publishedCount(tx, agencyId),
      agencyName: await this.repository.agencyName(tx, agencyId),
    }));
  }

  publishedStories(agencyId: string, limit: number) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.publishedStories(tx, agencyId, limit),
    );
  }

  /** Sets a story's photo and/or wedding date and records the event together; undefined when there is no such story. */
  setStoryDetails(
    agencyId: string,
    storyId: string,
    change: { photoFile?: string | null; weddingDate?: string | null },
    event: WorkflowEvent,
  ) {
    return this.db.transaction(agencyId, async (tx) => {
      const result = await this.repository.setStoryDetails(tx, agencyId, storyId, change);
      if (result) await this.events.append(tx, event);
      return result;
    });
  }

  storyPhotoFile(agencyId: string, storyId: string) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.storyPhotoFile(tx, agencyId, storyId),
    );
  }

  isPublishedPhoto(agencyId: string, file: string) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.isPublishedPhoto(tx, agencyId, file),
    );
  }

  /** Changes the content and records the event together. */
  update(
    agencyId: string,
    change: (current: Record<string, unknown>) => Record<string, unknown>,
    event: WorkflowEvent,
  ) {
    return this.db.transaction(agencyId, async (tx) => {
      const next = change(await this.repository.config(tx, agencyId));
      await this.repository.saveConfig(tx, agencyId, next);
      await this.events.append(tx, event);
      return next;
    });
  }
}
