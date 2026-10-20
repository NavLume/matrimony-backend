import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { canManage, isStaff } from '../bo/access.js';
import {
  MAX_PROPOSALS,
  POOL_LIMIT,
  type CandidateList,
  type CandidateListQuery,
  type GenerationResult,
} from '../bo/candidate.js';
import type { WorkflowEvent } from '../bo/event.js';
import { compareFit, pairFit } from '../bo/matching.js';
import type { MatchingReadiness, ReadinessOverrideInput } from '../bo/readiness.js';
import type { ProfileRecord } from '../bo/profile-state.js';
import {
  DEFAULT_CAP,
  DEFAULT_VISIBLE_FIELDS,
  type CandidateIdsInput,
  type ReleaseOutcome,
  type ReleaseSettings,
  type SettingsInput,
} from '../bo/release.js';
import type { CandidateDbService, CandidateUnit } from '../db/service/candidate-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/**
 * Candidate lists for the discovery loop (slice 3.B, docs/features/candidate-generation.md).
 *
 * - Only staff generate or read a list. An admin reaches every client; an agent only their own. A
 *   client an agent may not manage is reported as not found.
 * - A list is made only for a published client, from published profiles of the same agency and the
 *   other gender. Both sides' preferences are measured and ranked together, and a mismatch lowers a
 *   candidate but never removes it: staff decide.
 * - A run adds and refreshes proposals. What staff already released or removed is never touched,
 *   and a proposal that no longer ranks among the best lapses (it can return later).
 * - Runs for one client go one after the other (the client's row is locked), so two staff pressing
 *   the button at once cannot interleave their writes.
 * - Nothing here is shown to the client. Releasing a list is slice 3.C.
 */
export class CandidateService {
  constructor(
    private readonly db: Pick<CandidateDbService, 'inTransaction'>,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Staff pressed "Find candidates". */
  async generate(actor: ProfileActor, profileId: string): Promise<GenerationResult> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.lockClient(actor.agencyId, profileId);
      if (!client || !canManage(actor, client)) throw new AppError(404, 'PROFILE_NOT_FOUND');
      if (client.status !== 'active') throw new AppError(409, 'PROFILE_NOT_PUBLISHED');
      await this.mustBeReady(unit, actor.agencyId, client.id);
      if (!client.data.profile.gender) throw new AppError(422, 'CLIENT_GENDER_REQUIRED');
      return this.run(unit, actor.agencyId, client);
    });
  }

  /**
   * After staff approved a profile's first submission or a change: its own list is refreshed. Quietly
   * does nothing for a profile that cannot have one. Not for other clients: a profile that just
   * changed shows up in their lists the next time staff press the button.
   */
  async refresh(agencyId: string, profileId: string): Promise<GenerationResult | null> {
    return this.db.inTransaction(agencyId, async (unit) => {
      const client = await unit.lockClient(agencyId, profileId);
      if (!client || client.status !== 'active' || !client.data.profile.gender) return null;
      return this.run(unit, agencyId, client);
    });
  }

  /**
   * Once a day, for an agency: every published client's list of proposals is refreshed, so an agent
   * who forgot to press "Find candidates" still finds new members there. What staff already released
   * or removed is not touched (same rule as the button). Returns how many clients were refreshed, or
   * `null` when today's run was already done, which is what makes a restart or a second process safe.
   */
  async refreshNightly(agencyId: string): Promise<number | null> {
    const now = this.now();
    const claimed = await this.db.inTransaction(agencyId, (unit) =>
      unit.claimJob(agencyId, 'candidates.nightly', now, startOfBangladeshDay(now)),
    );
    if (!claimed) return null;
    const ids = await this.db.inTransaction(agencyId, (unit) => unit.activeClients(agencyId));
    let refreshed = 0;
    for (const id of ids) {
      try {
        if (await this.refresh(agencyId, id)) refreshed += 1;
      } catch {
        // One client must not stop the rest. The code is logged; the next night tries again.
        this.logger.error(
          { code: 'CANDIDATE_NIGHTLY_FAILED', agencyId, profileId: id },
          'Nightly refresh failed for one client',
        );
      }
    }
    return refreshed;
  }

  async list(
    actor: ProfileActor,
    profileId: string,
    query: CandidateListQuery,
  ): Promise<CandidateList> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.readClient(actor.agencyId, profileId);
      if (!client || !canManage(actor, client)) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return {
        items: await unit.list(actor.agencyId, profileId, query.state, query.limit, this.now()),
      };
    });
  }

  /** Whether matching may start for the client: the agreed amount recorded and the document verified. */
  async readiness(actor: ProfileActor, profileId: string): Promise<MatchingReadiness> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.readClient(actor.agencyId, profileId);
      if (!client || !canManage(actor, client)) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return unit.readiness(actor.agencyId, client.id);
    });
  }

  /** An admin lets a client through without the two steps, with a reason that stays on record. */
  async overrideReadiness(
    actor: ProfileActor,
    profileId: string,
    input: ReadinessOverrideInput,
    correlationId: string,
  ): Promise<MatchingReadiness> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.lockClient(actor.agencyId, profileId);
      if (!client) throw new AppError(404, 'PROFILE_NOT_FOUND');
      await unit.setOverride(actor.agencyId, client.id, actor.accountId, input.reason);
      await unit.appendEvent(
        this.event('candidates.ready_override', actor, client.id, correlationId),
      );
      return unit.readiness(actor.agencyId, client.id);
    });
  }

  /** The client's cap and which fields they will see, with how full the window is. */
  async settings(actor: ProfileActor, profileId: string): Promise<ReleaseSettings> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await unit.readClient(actor.agencyId, profileId);
      if (!client || !canManage(actor, client)) throw new AppError(404, 'PROFILE_NOT_FOUND');
      return this.settingsOf(unit, actor.agencyId, profileId);
    });
  }

  /** Staff set the cap and the visible fields. The cap cannot drop below what is already released. */
  async saveSettings(
    actor: ProfileActor,
    profileId: string,
    input: SettingsInput,
    correlationId: string,
  ): Promise<ReleaseSettings> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await this.lockManaged(unit, actor, profileId);
      const released = await unit.releasedCount(actor.agencyId, client.id);
      if (input.cap < released) throw new AppError(409, 'CAP_BELOW_RELEASED', { released });
      await unit.saveSettings(actor.agencyId, client.id, input, actor.accountId);
      await unit.appendEvent(
        this.event('candidates.settings_changed', actor, client.id, correlationId),
      );
      return this.settingsOf(unit, actor.agencyId, client.id);
    });
  }

  /**
   * Staff release proposed candidates to the client. Only profiles that are still proposed and still
   * published move; the rest are reported as skipped. The window is never exceeded: if more would be
   * released than there is room for, nothing is released.
   */
  async release(
    actor: ProfileActor,
    profileId: string,
    input: CandidateIdsInput,
    correlationId: string,
  ): Promise<ReleaseOutcome> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await this.lockManaged(unit, actor, profileId);
      await this.mustBeReady(unit, actor.agencyId, client.id);
      const { cap } = await this.settingsOf(unit, actor.agencyId, client.id);
      const room = cap - (await unit.releasedCount(actor.agencyId, client.id));
      const ready = await unit.releasable(actor.agencyId, client.id, input.candidateIds);
      if (ready.length > room)
        throw new AppError(409, 'CAP_REACHED', { cap, room: Math.max(room, 0) });
      const done =
        ready.length === 0
          ? []
          : await unit.markReleased(actor.agencyId, client.id, ready, actor.accountId);
      if (done.length > 0) {
        await unit.appendEvent(this.event('candidates.released', actor, client.id, correlationId));
      }
      return { done, skipped: input.candidateIds.filter((id) => !done.includes(id)) };
    });
  }

  /** Staff remove candidates for good: they leave the proposals and the client's window, and never return. */
  async remove(
    actor: ProfileActor,
    profileId: string,
    input: CandidateIdsInput,
    correlationId: string,
  ): Promise<ReleaseOutcome> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const client = await this.lockManaged(unit, actor, profileId);
      const done = await unit.markRemoved(
        actor.agencyId,
        client.id,
        input.candidateIds,
        actor.accountId,
      );
      if (done.length > 0) {
        await unit.appendEvent(this.event('candidates.removed', actor, client.id, correlationId));
      }
      return { done, skipped: input.candidateIds.filter((id) => !done.includes(id)) };
    });
  }

  // ------------------------------------------------------------------------------------------

  /** The client, locked, if this staff member may manage them. Otherwise not found. */
  private async lockManaged(unit: CandidateUnit, actor: ProfileActor, profileId: string) {
    const client = await unit.lockClient(actor.agencyId, profileId);
    if (!client || !canManage(actor, client)) throw new AppError(404, 'PROFILE_NOT_FOUND');
    return client;
  }

  private async mustBeReady(unit: CandidateUnit, agencyId: string, clientId: string) {
    const state = await unit.readiness(agencyId, clientId);
    if (!state.ready)
      throw new AppError(409, 'MATCHING_NOT_READY', {
        agreementRecorded: state.agreementRecorded,
        verified: state.verified,
      });
  }

  private async settingsOf(
    unit: CandidateUnit,
    agencyId: string,
    clientId: string,
  ): Promise<ReleaseSettings> {
    const saved = await unit.settings(agencyId, clientId);
    return {
      cap: saved?.cap ?? DEFAULT_CAP,
      visibleFields: saved?.visibleFields ?? [...DEFAULT_VISIBLE_FIELDS],
      allowCodeSearch: saved?.allowCodeSearch ?? false,
      releasedCount: await unit.releasedCount(agencyId, clientId),
      isDefault: saved === null,
    };
  }

  private event(
    type: Extract<
      WorkflowEvent['type'],
      | 'candidates.released'
      | 'candidates.removed'
      | 'candidates.settings_changed'
      | 'candidates.ready_override'
    >,
    actor: ProfileActor,
    clientId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
      subjectId: clientId,
    };
  }

  private async run(
    unit: CandidateUnit,
    agencyId: string,
    client: ProfileRecord,
  ): Promise<GenerationResult> {
    const today = this.now();
    const pool = await unit.pool(agencyId, client.id, client.data.profile.gender!, POOL_LIMIT);
    if (pool.length >= POOL_LIMIT) {
      // Profiles beyond the bound were not measured. Say so loudly rather than quietly drop people.
      this.logger.warn({ code: 'CANDIDATE_POOL_LIMIT', agencyId, limit: POOL_LIMIT }, 'pool bound');
    }
    const best = pool
      .map((candidate) => ({ candidate, fit: pairFit(client.data, candidate.data, today) }))
      .sort((a, b) =>
        compareFit(
          { ...a.fit, createdAt: a.candidate.createdAt, id: a.candidate.id },
          { ...b.fit, createdAt: b.candidate.createdAt, id: b.candidate.id },
        ),
      )
      .slice(0, MAX_PROPOSALS);
    await unit.saveProposals(
      agencyId,
      client.id,
      best.map(({ candidate, fit }) => ({
        candidateId: candidate.id,
        met: fit.met,
        unmet: fit.unmet,
        unknown: fit.unknown,
        forward: fit.forward,
        reverse: fit.reverse,
      })),
    );
    return {
      items: await unit.list(agencyId, client.id, 'proposed', MAX_PROPOSALS, today),
      considered: pool.length,
      proposed: best.length,
    };
  }

  private requireStaff(actor: ProfileActor) {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}

/**
 * Midnight of the current day in Bangladesh (UTC+6, no daylight saving), as an instant. A daily job
 * counts days by it, so "once a day" means a Bangladesh day whatever the server's timezone is.
 */
export function startOfBangladeshDay(now: Date): Date {
  const OFFSET_MS = 6 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + OFFSET_MS);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnightLocal - OFFSET_MS);
}
