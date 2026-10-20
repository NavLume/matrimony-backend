import { randomUUID } from 'node:crypto';
import { AGREEMENT_ROLES, type AgreementsStatus } from '../bo/agreements.js';
import type { LegalVersionSource } from '../bo/legal.js';
import type { AgreementDbService } from '../db/service/agreement-db-service.js';
import type { ProfileActor } from './profile-service.js';

/** How long the answer "no need to agree" is trusted, so a request does not always ask the database. */
const CACHE_MS = 10_000;

/**
 * Agreeing again to the agency's current terms and privacy text (see bo/agreements.ts). A person must agree
 * when the version they last agreed to is not the version the agency shows now.
 */
export class AgreementService {
  private readonly cache = new Map<string, { until: number; required: boolean }>();

  constructor(
    private readonly db: Pick<AgreementDbService, 'accepted' | 'accept'>,
    private readonly versions: LegalVersionSource,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async status(
    actor: Pick<ProfileActor, 'agencyId' | 'accountId' | 'role'>,
  ): Promise<AgreementsStatus> {
    const [current, accepted] = await Promise.all([
      this.versions(actor.agencyId),
      this.db.accepted(actor.agencyId, actor.accountId),
    ]);
    const asked = (AGREEMENT_ROLES as readonly string[]).includes(actor.role);
    return {
      required: asked && (accepted.terms !== current.terms || accepted.privacy !== current.privacy),
      terms: { current: current.terms, accepted: accepted.terms },
      privacy: { current: current.privacy, accepted: accepted.privacy },
    };
  }

  /** Whether this person must agree before anything else. Staff never must. */
  async mustAgree(actor: Pick<ProfileActor, 'agencyId' | 'accountId' | 'role'>): Promise<boolean> {
    if (!(AGREEMENT_ROLES as readonly string[]).includes(actor.role)) return false;
    const key = `${actor.agencyId}:${actor.accountId}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now().getTime()) return cached.required;
    const { required } = await this.status(actor);
    this.cache.set(key, { until: this.now().getTime() + CACHE_MS, required });
    return required;
  }

  /** Records the agreement to the versions shown now. */
  async accept(actor: ProfileActor, correlationId: string): Promise<AgreementsStatus> {
    const status = await this.status(actor);
    const versions: { purpose: 'terms' | 'privacy'; version: string }[] = [];
    if (status.terms.accepted !== status.terms.current)
      versions.push({ purpose: 'terms', version: status.terms.current });
    if (status.privacy.accepted !== status.privacy.current)
      versions.push({ purpose: 'privacy', version: status.privacy.current });
    if (versions.length > 0) {
      await this.db.accept(actor.agencyId, actor.accountId, versions, {
        id: this.newId(),
        agencyId: actor.agencyId,
        actorId: actor.accountId,
        subjectId: null,
        type: 'agreements.accepted',
        version: 1,
        occurredAt: this.now().toISOString(),
        correlationId,
      });
    }
    this.cache.delete(`${actor.agencyId}:${actor.accountId}`);
    return this.status(actor);
  }
}
