/**
 * Where uploaded files live. The application only ever talks to this interface, so moving from
 * the local disk to Amazon S3 (or any S3-compatible store: Cloudflare R2, DigitalOcean Spaces,
 * MinIO) is a configuration change (`STORAGE_DRIVER`), not a code change.
 *
 * Keys are slash-separated paths such as `agency/profile/photo.full.webp`. Every operation is
 * safe to repeat: a second delete of a missing key is not an error.
 */
export interface FileStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** The file, or null when there is no file under that key. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Keys are built by the application, but a bad one must never reach a disk path or a bucket. */
export const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function assertSafeKey(key: string): void {
  if (key.length > 300 || !SAFE_KEY.test(key) || key.split('/').some((part) => part.includes('..')))
    throw new Error('Unsafe storage key');
}
