import { randomUUID } from 'node:crypto';
import { canManage } from '../bo/access.js';
import type { MarkMatchedInput } from '../bo/couple-match.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { MatchProfile } from '../db/raw/repository/couple-match-repository.js';
import type { CoupleMatchDbService } from '../db/service/couple-match-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  'match.recorded' | 'story.published' | 'story.hidden'
>;

/**
 * The matched step (see bo/couple-match.ts).
 *
 * - Only for an accepted connection whose two clients are both published.
 * - An admin may mark any connection; an agent only one whose two clients they both look after. With
 *   two different agents it is an admin's step.
 * - Everything happens in one transaction: both clients, their other waiting proposals, the success
 *   fees, the record and the first draft of a story.
 */
export class CoupleMatchService {
  constructor(
    private readonly db: Pick<CoupleMatchDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async markMatched(
    actor: ProfileActor,
    connectionId: string,
    input: MarkMatchedInput,
    correlationId: string,
  ): Promise<{ matchedAt: string }> {
    if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const interest = await unit.interest(actor.agencyId, connectionId);
      if (!interest) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      // Locked in a fixed order, so two people marking the same pair cannot deadlock.
      const [first, second] = [interest.aId, interest.bId].sort();
      const lockedFirst = await unit.profile(actor.agencyId, first!);
      const lockedSecond = await unit.profile(actor.agencyId, second!);
      const a = interest.aId === first ? lockedFirst : lockedSecond;
      const b = interest.aId === first ? lockedSecond : lockedFirst;
      if (!a || !b) throw new AppError(404, 'CONNECTION_NOT_FOUND');
      this.allowed(actor, a, b);
      if (interest.status !== 'accepted') throw new AppError(409, 'CONNECTION_NOT_ACCEPTED');
      if (await unit.existing(actor.agencyId, connectionId))
        throw new AppError(409, 'ALREADY_MATCHED');
      if (a.status !== 'active' || b.status !== 'active')
        throw new AppError(
          409,
          a.status === 'matched' || b.status === 'matched'
            ? 'ALREADY_MATCHED'
            : 'PROFILE_NOT_ACTIVE',
        );
      const ids = new Set([a.id, b.id]);
      for (const fee of input.fees)
        if (!ids.has(fee.profileId))
          throw new AppError(400, 'INVALID_REQUEST', {
            fields: [{ path: 'fees', code: 'invalid' }],
          });
      for (const profile of [a, b]) await unit.matchProfile(actor.agencyId, profile.id);
      for (const fee of input.fees)
        await unit.setSuccessFee(actor.agencyId, fee.profileId, fee.amount, actor.accountId);
      const matchId = await unit.insertMatch(actor.agencyId, {
        interestId: connectionId,
        a: a.id,
        b: b.id,
        by: actor.accountId,
        note: input.note ?? null,
      });
      if (input.story && (input.story.names.bn || input.story.names.en)) {
        await unit.insertStory(actor.agencyId, {
          matchId,
          names: input.story.names,
          text: input.story.text,
          year: input.story.year ?? this.now().getUTCFullYear(),
          consentA: input.story.consentFrom.includes(a.id),
          consentB: input.story.consentFrom.includes(b.id),
          by: actor.accountId,
        });
      }
      await unit.appendEvent(this.event('match.recorded', actor, matchId, correlationId));
      return { matchedAt: this.now().toISOString() };
    });
  }

  /** Publishes a success story (only once both clients agreed) or hides it again. Admins only. */
  async setStoryStatus(
    actor: ProfileActor,
    storyId: string,
    status: 'published' | 'hidden',
    correlationId: string,
  ): Promise<void> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    await this.db.inTransaction(actor.agencyId, async (unit) => {
      const result = await unit.setStoryStatus(actor.agencyId, storyId, status);
      if (!result) throw new AppError(404, 'STORY_NOT_FOUND');
      if (!result.changed) throw new AppError(409, 'CONSENT_MISSING');
      await unit.appendEvent(
        this.event(
          status === 'published' ? 'story.published' : 'story.hidden',
          actor,
          storyId,
          correlationId,
        ),
      );
    });
  }

  private allowed(actor: ProfileActor, a: MatchProfile, b: MatchProfile) {
    if (actor.role === 'admin') return;
    const who = { accountId: actor.accountId, role: actor.role };
    const mineA = canManage(who, a);
    const mineB = canManage(who, b);
    // An agent who looks after neither is told the connection is not theirs; one who looks after only
    // one side must ask an admin, because the other client has a different agent.
    if (!mineA && !mineB) throw new AppError(404, 'CONNECTION_NOT_FOUND');
    if (!(mineA && mineB)) throw new AppError(403, 'MATCH_NEEDS_ADMIN');
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: this.newId(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      subjectId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
    };
  }
}
