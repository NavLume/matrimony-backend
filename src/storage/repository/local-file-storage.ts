import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { assertSafeKey, type FileStorage } from '../service/file-storage.js';

/**
 * Keeps files on the server's own disk, for development and single-server use. A file is
 * written under a temporary name and then renamed, so a reader never sees half a file.
 * It is not suitable once the API runs on more than one server: use the S3 driver then.
 */
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  private pathOf(key: string) {
    assertSafeKey(key);
    const path = resolve(this.root, key);
    // Belt and braces: the key check already refuses `..`, this refuses anything that escaped.
    if (!path.startsWith(this.root + sep)) throw new Error('Unsafe storage key');
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
