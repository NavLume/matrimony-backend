import type { IdentityDbService } from '../db/service/identity-db-service.js';
import type { Tenant } from '../bo/identity.js';
import { AppError } from '../exception/app-error.js';
const CODE_CACHE_MS = 60_000;
export class IdentityService {
  private codes: Map<string, Tenant> | null = null;
  private codesAt = 0;
  constructor(
    private readonly db: IdentityDbService,
    private readonly hosts: Record<string, string>,
  ) {}
  async tenant(hostname: string) {
    const id = this.hosts[hostname];
    if (!id) throw new AppError(404, 'TENANT_NOT_FOUND');
    const tenant = await this.db.tenant(id);
    if (!tenant || tenant.hostname !== hostname) throw new AppError(404, 'TENANT_NOT_FOUND');
    return tenant;
  }
  /**
   * The agency that has this app code. Agencies are read one at a time (each is behind its own
   * row-level security), so the codes are kept in memory for a minute and read again after that.
   */
  async byCode(code: string) {
    if (!this.codes || Date.now() - this.codesAt > CODE_CACHE_MS) {
      const found = new Map<string, Tenant>();
      const ids = [...new Set(Object.values(this.hosts))];
      for (const id of ids) {
        const tenant = await this.db.tenant(id);
        if (tenant?.appCode) found.set(tenant.appCode, tenant);
      }
      this.codes = found;
      this.codesAt = Date.now();
    }
    const tenant = this.codes.get(code);
    if (!tenant) throw new AppError(404, 'AGENCY_CODE_NOT_FOUND');
    return tenant;
  }
  /** The active account with this id, read fresh so a disabled account or a changed role applies at once. */
  async account(agencyId: string, accountId: string) {
    const account = await this.db.account(agencyId, accountId);
    if (!account) throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
    return account;
  }
}
