import type { PublicConfig } from './public-config.js';
export interface Account {
  id: string;
  agencyId: string;
  role: 'admin' | 'agent' | 'member' | 'guardian';
  displayName: string;
}
export type Principal = Account;
export interface Tenant {
  id: string;
  hostname: string;
  name: string;
  locale: string;
  publicConfig: PublicConfig;
  /** The short code a person types in the mobile app to reach this agency. */
  appCode?: string | null;
}
