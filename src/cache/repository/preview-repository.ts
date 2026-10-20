import type { Redis } from 'ioredis';

/** What a preview keeps: the agency's public content as it would look if the draft were saved. */
export interface StoredPreview {
  name: string;
  locale: 'bn' | 'en';
  content: unknown;
}

/**
 * Drafts of the public site that an admin looks at before saving (see SiteContentService.preview).
 * A draft is kept for a short time under a random link, per agency, and is never written to the database.
 */
export class PreviewRepository {
  constructor(private readonly redis: Redis) {}

  private key(agencyId: string, id: string) {
    return `matrimony:site-preview:${agencyId}:${id}`;
  }

  async put(agencyId: string, id: string, preview: StoredPreview, ttlSeconds: number) {
    await this.redis.set(this.key(agencyId, id), JSON.stringify(preview), 'EX', ttlSeconds);
  }

  async get(agencyId: string, id: string): Promise<StoredPreview | null> {
    const raw = await this.redis.get(this.key(agencyId, id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredPreview;
    } catch {
      return null;
    }
  }
}
