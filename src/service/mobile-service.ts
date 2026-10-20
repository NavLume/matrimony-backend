import type { AppConfig } from '../config/env.js';
import type { IdentityService } from './identity-service.js';
import type { SiteContentService } from './site-content-service.js';

export type AppPlatform = 'ios' | 'android';

const parts = (version: string) => version.split('.').map(Number);

/** Negative when `a` is older than `b`, zero when they are the same, positive when newer. */
export function compareVersions(a: string, b: string) {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * What the mobile app asks before anyone is signed in: which agency a code belongs to, and whether this
 * version of the app may still be used. Neither needs a session, and neither reads anything private.
 */
export class MobileService {
  constructor(
    private readonly identities: Pick<IdentityService, 'byCode'>,
    private readonly config: Pick<
      AppConfig,
      | 'APP_MIN_VERSION_IOS'
      | 'APP_MIN_VERSION_ANDROID'
      | 'APP_LATEST_VERSION_IOS'
      | 'APP_LATEST_VERSION_ANDROID'
      | 'APP_STORE_URL_IOS'
      | 'APP_STORE_URL_ANDROID'
    >,
    private readonly siteContent?: Pick<SiteContentService, 'withStories'>,
  ) {}

  /** The public look of an agency, and the address the app talks to for it. */
  async agencyByCode(code: string) {
    const tenant = await this.identities.byCode(code.trim().toUpperCase());
    return {
      code: tenant.appCode!,
      hostname: tenant.hostname,
      name: tenant.name,
      locale: tenant.locale,
      content: this.siteContent
        ? await this.siteContent.withStories(tenant.id, tenant.publicConfig)
        : tenant.publicConfig,
    };
  }

  versionStatus(platform: AppPlatform, version: string) {
    const ios = platform === 'ios';
    const minimumVersion = ios
      ? this.config.APP_MIN_VERSION_IOS
      : this.config.APP_MIN_VERSION_ANDROID;
    const latestVersion =
      (ios ? this.config.APP_LATEST_VERSION_IOS : this.config.APP_LATEST_VERSION_ANDROID) ?? null;
    return {
      supported: compareVersions(version, minimumVersion) >= 0,
      updateAvailable: latestVersion !== null && compareVersions(version, latestVersion) < 0,
      minimumVersion,
      latestVersion,
      storeUrl: (ios ? this.config.APP_STORE_URL_IOS : this.config.APP_STORE_URL_ANDROID) ?? null,
    };
  }
}
