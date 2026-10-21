import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { PHOTO_VARIANTS, variantKey, type PhotoVariant } from '../bo/photo.js';
import { normalizePassword } from '../bo/credentials.js';
import type { AuthProcess } from './auth-process.js';
import type { SessionRepository } from '../cache/repository/session-repository.js';
import type { AccountDeletionDbService } from '../db/service/account-deletion-db-service.js';
import type { EventDbService } from '../db/service/event-db-service.js';
import type { FileStorage } from '../storage/service/file-storage.js';
import { AppError } from '../exception/app-error.js';

/** How long a person has to change their mind before everything personal is erased. */
export const DELETION_GRACE_DAYS = 14;
/** The same for a client with no login, whom an admin can still keep by cancelling. */
export const CLIENT_ERASURE_GRACE_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;

/**
 * A member deleting their own account. Asking hides the profile, withdraws open requests and signs
 * the person out everywhere. Signing in again within 14 days cancels it. After that the erase job
 * removes everything personal and keeps a bare history (see migration 027).
 */
export class AccountDeletionProcess {
  constructor(
    private readonly db: Pick<
      AccountDeletionDbService,
      | 'account'
      | 'request'
      | 'cancel'
      | 'eraseDue'
      | 'scheduleClient'
      | 'cancelClient'
      | 'eraseDueClients'
    >,
    private readonly auth: Pick<AuthProcess, 'checkPassword' | 'checkPhonePassword'>,
    private readonly sessions: Pick<SessionRepository, 'removeAll'>,
    private readonly storage: Pick<FileStorage, 'delete'>,
    private readonly events: Pick<EventDbService, 'record'>,
    private readonly logger: Logger,
    /** Conversations of an erased account end and their messages go with it. */
    private readonly chats?: { eraseFor(agencyId: string, accountId: string): Promise<void> },
  ) {}

  async request(
    actor: { agencyId: string; accountId: string },
    password: string,
    correlationId: string,
  ) {
    const account = await this.db.account(actor.agencyId, actor.accountId);
    if (!account || account.role !== 'member' || account.erased)
      throw new AppError(403, 'ROLE_FORBIDDEN');
    // Asking for the password again is what stops a borrowed phone from deleting an account.
    if (!account.hasPassword) throw new AppError(409, 'PASSWORD_REQUIRED');
    const given = normalizePassword(password);
    if (account.email) await this.auth.checkPassword(actor.agencyId, account.email, given);
    else if (account.phone)
      await this.auth.checkPhonePassword(actor.agencyId, account.phone, given);
    else throw new AppError(409, 'PASSWORD_REQUIRED');

    const requested = await this.db.request(actor.agencyId, actor.accountId);
    if (!requested) throw new AppError(409, 'DELETION_NOT_POSSIBLE');
    await this.sessions.removeAll(actor.accountId);
    await this.record('account.deletion_requested', actor.agencyId, actor.accountId, correlationId);
    return {
      scheduledFor: new Date(requested.getTime() + DELETION_GRACE_DAYS * DAY_MS).toISOString(),
    };
  }

  /** Called when the person signs in. Does nothing unless a deletion was waiting. */
  async cancelOnSignIn(agencyId: string, accountId: string) {
    if (await this.db.cancel(agencyId, accountId))
      await this.record(
        'account.deletion_cancelled',
        agencyId,
        accountId,
        `signin-${randomUUID()}`,
      );
  }

  /** Erases the accounts and the clients whose waiting time is over, and deletes their files. */
  async eraseDue(agencyId: string, now: Date = new Date(), limit = 20) {
    const before = new Date(now.getTime() - DELETION_GRACE_DAYS * DAY_MS);
    const rows = await this.db.eraseDue(agencyId, before, limit);
    for (const row of rows) await this.deleteFile(row);
    const accounts = [...new Set(rows.map((row) => row.account_id))];
    for (const accountId of accounts) {
      await this.chats?.eraseFor(agencyId, accountId);
      await this.record('account.erased', agencyId, accountId, `erase-${randomUUID()}`);
    }
    const clientRows = await this.db.eraseDueClients(
      agencyId,
      new Date(now.getTime() - CLIENT_ERASURE_GRACE_DAYS * DAY_MS),
      limit,
    );
    for (const row of clientRows) await this.deleteFile(row);
    const clients = [...new Set(clientRows.map((row) => row.profile_id))];
    for (const profileId of clients)
      await this.recordClient('client.erased', agencyId, null, profileId, `erase-${randomUUID()}`);
    return accounts.length + clients.length;
  }

  /** Deletes one erased file from storage. A photo has size variants; anything else is one object. */
  private async deleteFile(row: { file_key: string | null; file_kind: 'photo' | 'file' | null }) {
    if (!row.file_key) return;
    const keys =
      row.file_kind === 'photo'
        ? (Object.keys(PHOTO_VARIANTS) as PhotoVariant[]).map((variant) =>
            variantKey(row.file_key!, variant),
          )
        : [row.file_key];
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // Only the code is logged: a storage error can carry the bucket or the path.
        this.logger.error({ code: 'ERASE_FILE_DELETE_FAILED' }, 'Could not delete a file');
      }
    }
  }

  /**
   * An admin asking for the erasure of a client who has no login (they cannot ask themselves). The profile is
   * hidden now and erased after 7 days unless an admin cancels. Null when the profile is not an assisted client
   * with no login, or is already scheduled or erased.
   */
  async scheduleClient(
    actor: { agencyId: string; accountId: string },
    profileId: string,
    reason: string,
    correlationId: string,
  ) {
    const scheduled = await this.db.scheduleClient(
      actor.agencyId,
      profileId,
      actor.accountId,
      reason,
    );
    if (!scheduled) return null;
    await this.recordClient(
      'client.erasure_scheduled',
      actor.agencyId,
      actor.accountId,
      profileId,
      correlationId,
    );
    return new Date(scheduled.getTime() + CLIENT_ERASURE_GRACE_DAYS * DAY_MS);
  }

  /** Stops a scheduled erasure and brings the profile back as it was. False when nothing was scheduled. */
  async cancelClient(
    actor: { agencyId: string; accountId: string },
    profileId: string,
    correlationId: string,
  ) {
    if (!(await this.db.cancelClient(actor.agencyId, profileId))) return false;
    await this.recordClient(
      'client.erasure_cancelled',
      actor.agencyId,
      actor.accountId,
      profileId,
      correlationId,
    );
    return true;
  }

  private recordClient(
    type: 'client.erasure_scheduled' | 'client.erasure_cancelled' | 'client.erased',
    agencyId: string,
    actorId: string | null,
    profileId: string,
    correlationId: string,
  ) {
    return this.events.record({
      id: randomUUID(),
      agencyId,
      actorId,
      subjectId: profileId,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
    });
  }

  private record(
    type: 'account.deletion_requested' | 'account.deletion_cancelled' | 'account.erased',
    agencyId: string,
    accountId: string,
    correlationId: string,
  ) {
    return this.events.record({
      id: randomUUID(),
      agencyId,
      actorId: type === 'account.erased' ? null : accountId,
      subjectId: accountId,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
    });
  }
}
