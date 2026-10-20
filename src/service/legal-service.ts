import { randomUUID } from 'node:crypto';
import {
  versionOf,
  type LegalDocument,
  type LegalInput,
  type LegalKind,
  type LegalVersions,
} from '../bo/legal.js';
import type { LegalDbService } from '../db/service/legal-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/** What the public page of a document needs. `custom` is false while the platform's draft applies. */
export interface PublicLegal {
  kind: LegalKind;
  version: string;
  custom: boolean;
  title?: LegalDocument['title'];
  body?: LegalDocument['body'];
}

/** The agency's terms and privacy policy (see bo/legal.ts). */
export class LegalService {
  constructor(
    private readonly db: Pick<LegalDbService, 'current' | 'save'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  /** The versions a registration records now. Read fresh, so a new text applies to the next person. */
  async versions(agencyId: string): Promise<LegalVersions> {
    const [terms, privacy] = await Promise.all([
      this.db.current(agencyId, 'terms'),
      this.db.current(agencyId, 'privacy'),
    ]);
    return { terms: versionOf('terms', terms), privacy: versionOf('privacy', privacy) };
  }

  async publicDocument(agencyId: string, kind: LegalKind): Promise<PublicLegal> {
    const document = await this.db.current(agencyId, kind);
    const version = versionOf(kind, document);
    const custom = version.startsWith('agency-v');
    return {
      kind,
      version,
      custom,
      ...(custom ? { title: document.title, body: document.body } : {}),
    };
  }

  /** Both documents as stored, for the editor. */
  async get(actor: ProfileActor): Promise<Record<LegalKind, LegalDocument>> {
    this.adminOnly(actor);
    const [terms, privacy] = await Promise.all([
      this.db.current(actor.agencyId, 'terms'),
      this.db.current(actor.agencyId, 'privacy'),
    ]);
    return { terms, privacy };
  }

  /** Saves a new version. Both texts empty goes back to the platform's draft (still a new version, so the history is whole). */
  async save(actor: ProfileActor, kind: LegalKind, input: LegalInput, correlationId: string) {
    this.adminOnly(actor);
    const document = await this.db.save(actor.agencyId, kind, input, actor.accountId, {
      id: this.newId(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      subjectId: null,
      type: 'legal.updated',
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    });
    return document;
  }

  private adminOnly(actor: ProfileActor) {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}
