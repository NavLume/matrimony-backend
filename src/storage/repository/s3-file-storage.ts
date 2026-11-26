import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { assertSafeKey, type FileStorage } from '../service/file-storage.js';

/** The part of the AWS client this needs, so a test can stand in for it. */
export type S3Sender = Pick<S3Client, 'send'>;

const isMissing = (error: unknown) => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/**
 * Keeps files in an S3 bucket. Works with Amazon S3 and with S3-compatible stores (Cloudflare
 * R2, DigitalOcean Spaces, MinIO) by setting `S3_ENDPOINT`. The bucket must stay private: files
 * are only ever served through the API, after a permission check.
 */
export class S3FileStorage implements FileStorage {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
  ) {}

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        // The files are private and may be fetched by the owner again and again.
        CacheControl: 'private, max-age=3600',
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    // S3 answers success whether or not the key existed, so a repeat is harmless.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
