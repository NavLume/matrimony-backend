import { randomUUID } from 'node:crypto';
import type { AgencySettings, SettingsInput } from '../bo/agency-settings.js';
import type { WorkflowEvent } from '../bo/event.js';
import type { SettingsDbService } from '../db/service/settings-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/** The agency's own settings (see bo/agency-settings.ts). Only an admin reads or changes them. */
export class SettingsService {
  constructor(
    private readonly db: Pick<SettingsDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async get(actor: ProfileActor): Promise<AgencySettings> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, (unit) => unit.get(actor.agencyId));
  }

  async save(
    actor: ProfileActor,
    input: SettingsInput,
    correlationId: string,
  ): Promise<AgencySettings> {
    if (actor.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      await unit.get(actor.agencyId, true);
      const settings: AgencySettings = {
        attention: input.attention,
        messaging: input.messaging,
      };
      await unit.save(actor.agencyId, settings);
      await unit.appendEvent({
        id: this.newId(),
        agencyId: actor.agencyId,
        actorId: actor.accountId,
        subjectId: null,
        type: 'settings.updated',
        version: 1,
        occurredAt: this.now().toISOString(),
        correlationId,
      } satisfies WorkflowEvent);
      return settings;
    });
  }
}
