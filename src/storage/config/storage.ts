import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../../config/env.js';
import type { FileStorage } from '../service/file-storage.js';
import { LocalFileStorage } from '../repository/local-file-storage.js';
import { S3FileStorage } from '../repository/s3-file-storage.js';

/** Builds the storage the configuration asks for. The only place that knows which one it is. */
export function createFileStorage(config: AppConfig): FileStorage {
  if (config.STORAGE_DRIVER === 'local') return new LocalFileStorage(config.STORAGE_LOCAL_DIR);
  return new S3FileStorage(
    new S3Client({
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      // Without keys the AWS SDK uses its normal credential chain (an instance role, for example).
      ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
      requestHandler: { requestTimeout: config.IO_TIMEOUT_MS * 4 },
    }),
    config.S3_BUCKET!,
  );
}
