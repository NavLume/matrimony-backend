import type { Database } from '../config/database.js';
import type { PushRepository } from '../raw/repository/push-repository.js';

export class PushDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: PushRepository,
  ) {}
  register(
    agencyId: string,
    accountId: string,
    device: { platform: 'ios' | 'android'; token: string; locale: 'bn' | 'en' },
  ) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.register(tx, agencyId, accountId, device),
    );
  }
  unregister(agencyId: string, accountId: string, token: string) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.unregister(tx, agencyId, accountId, token),
    );
  }
  forget(agencyId: string, deviceId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.forget(tx, agencyId, deviceId));
  }
  /** Claims the unsent lines and lists the phones in one transaction. */
  take(agencyId: string, accountId: string) {
    return this.db.transaction(agencyId, async (tx) => ({
      kinds: await this.repository.claim(tx, agencyId, accountId),
      devices: await this.repository.devices(tx, agencyId, accountId),
    }));
  }
}
