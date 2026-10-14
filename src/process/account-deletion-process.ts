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
      'account' | 'request' | 'cancel' | 'eraseDue'
    >,
    private readonly auth: Pick<AuthProcess, 'checkPassword' | 'checkPhonePassword'>,
    private readonly sessions: Pick<SessionRepository, 'removeAll'>,
    private readonly storage: Pick<FileStorage, 'delete'>,
    private readonly events: Pick<EventDbService, 'record'>,
    private readonly logger: Logger,
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

  /** Erases the accounts whose waiting time is over, and deletes their files. */
  async eraseDue(agencyId: string, now: Date = new Date(), limit = 20) {
    const before = new Date(now.getTime() - DELETION_GRACE_DAYS * DAY_MS);
    const rows = await this.db.eraseDue(agencyId, before, limit);
    for (const row of rows) {
      const keys = row.storage_key.endsWith('.pdf')
        ? [row.storage_key]
        : (Object.keys(PHOTO_VARIANTS) as PhotoVariant[]).map((variant) =>
            variantKey(row.storage_key, variant),
          );
      for (const key of keys) {
        try {
          await this.storage.delete(key);
        } catch {
          // Only the code is logged: a storage error can carry the bucket or the path.
          this.logger.error({ code: 'ERASE_FILE_DELETE_FAILED' }, 'Could not delete a file');
        }
      }
    }
    const accounts = [...new Set(rows.map((row) => row.account_id))];
    for (const accountId of accounts)
      await this.record('account.erased', agencyId, accountId, `erase-${randomUUID()}`);
    return accounts.length;
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
